import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/guards/supabase-auth.guard';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

type Track17Config = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  webhookUrl: string;
};

type Track17RequestItem = {
  number: string;
  carrier?: number;
  order_no?: string;
  tag?: string;
  lang?: string;
};

type Track17Record = Record<string, any> & {
  number?: string;
  carrier?: number;
  tag?: string;
  error?: { code?: string | number; message?: string };
  track_info?: Record<string, any>;
};

type RegistrationCounts = {
  accepted: number;
  rejected: number;
  skipped: number;
  failed: number;
};

@Injectable()
export class Track17Service {
  private readonly logger = new Logger(Track17Service.name);
  private requestQueue: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async status(user: AuthenticatedUser) {
    const config = this.readConfig(false);
    const safe = {
      enabled: config.enabled,
      configured: Boolean(config.apiKey && config.baseUrl),
      webhookUrlConfigured: Boolean(config.webhookUrl),
    };
    if (user.role !== 'TANJAI_ADMIN') return safe;
    const [registeredShipments, registrationErrors] = await Promise.all([
      this.prisma.shipment.count({
        where: { trackingRegistrationStatus: 'REGISTERED' },
      }),
      this.prisma.shipment.count({
        where: { trackingRegistrationStatus: 'ERROR' },
      }),
    ]);
    return { ...safe, registeredShipments, registrationErrors };
  }

  async registerPending(maxRecords: number | undefined) {
    const limit = clampInt(maxRecords, 100, 1, 400);
    const shipments = await this.prisma.shipment.findMany({
      where: {
        trackingRegistrationStatus: { in: ['UNREGISTERED', 'ERROR'] },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { order: { select: { externalOrderNumber: true } } },
    });
    return this.registerNormalizedShipments(shipments);
  }

  async registerByImportBatch(importBatchId: string) {
    if (!this.readConfig(false).enabled || !this.isConfigured()) {
      return { accepted: 0, rejected: 0, skipped: 0, failed: 0 };
    }
    const shipments = await this.prisma.shipment.findMany({
      where: {
        order: { importBatchId },
        trackingRegistrationStatus: 'UNREGISTERED',
      },
      include: { order: { select: { externalOrderNumber: true } } },
      take: 2000,
    });
    return this.registerNormalizedShipments(shipments);
  }

  async captureExplicitOrderShipments(
    orderId: string,
    trackingNumbers: string[],
    sourceSheet: string,
  ) {
    const normalized = [
      ...new Set(
        trackingNumbers
          .map(normalizeTrackingNumber)
          .filter(isValidTrackingNumber),
      ),
    ];
    if (!normalized.length) return { captured: 0 };
    let sourceRow = 1;
    for (const trackingNumber of normalized) {
      await this.prisma.shipment.upsert({
        where: { orderId_trackingNumber: { orderId, trackingNumber } },
        update: { normalizedTrackingNumber: trackingNumber },
        create: {
          orderId,
          trackingNumber,
          normalizedTrackingNumber: trackingNumber,
          sourceSheet,
          sourceRow: sourceRow++,
        },
      });
    }
    if (this.readConfig(false).enabled && this.isConfigured()) {
      const shipments = await this.prisma.shipment.findMany({
        where: {
          orderId,
          trackingNumber: { in: normalized },
          trackingRegistrationStatus: { in: ['UNREGISTERED', 'ERROR'] },
        },
        include: { order: { select: { externalOrderNumber: true } } },
      });
      void this.registerNormalizedShipments(shipments).catch((error) =>
        this.logger.warn(
          `Automatic 17TRACK registration failed for order ${orderId}: ${safeErrorMessage(error)}`,
        ),
      );
    }
    return { captured: normalized.length };
  }

  async registerShipment(
    shipmentId: string,
    user: AuthenticatedUser,
    carrierCodeInput?: number,
  ) {
    let shipment = await this.accessibleShipment(shipmentId, user);
    if (carrierCodeInput !== undefined) {
      if (!isValidCarrierCode(carrierCodeInput)) {
        throw new BadRequestException(
          'Carrier code must be a valid numeric 17TRACK carrier code.',
        );
      }
      shipment = await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: { carrierCode: Number(carrierCodeInput) },
        include: {
          order: { select: { storeId: true, externalOrderNumber: true } },
          trackingEvents: true,
        },
      });
    }
    if (shipment.trackingRegistrationStatus === 'REGISTERED') {
      return this.safeShipment(shipment);
    }
    await this.registerNormalizedShipments([shipment]);
    return this.safeShipment(
      await this.prisma.shipment.findUnique({ where: { id: shipment.id } }),
    );
  }

  async refreshShipment(shipmentId: string, user: AuthenticatedUser) {
    const shipment = await this.accessibleShipment(shipmentId, user);
    const number = normalizeTrackingNumber(shipment.trackingNumber);
    if (!isValidTrackingNumber(number)) {
      throw new BadRequestException('This shipment has no valid tracking number.');
    }
    const requestItem: Track17RequestItem = { number };
    if (isValidCarrierCode(shipment.carrierCode)) {
      requestItem.carrier = shipment.carrierCode;
    }
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { trackingLastRequestedAt: new Date() },
    });
    const response = await this.getTrackInfo([requestItem]);
    const accepted = recordsFromData(response.data, 'accepted');
    const record = accepted.find(
      (item) => normalizeTrackingNumber(item.number) === number,
    );
    if (!record) {
      const rejected = recordsFromData(response.data, 'rejected')[0];
      if (rejected) await this.saveRegistrationError(shipment.id, rejected);
      throw new BadGatewayException('17TRACK did not return tracking information.');
    }
    await this.persistTrackingRecord(shipment, record, 'MANUAL_REFRESH');
    return this.safeShipment(
      await this.prisma.shipment.findUnique({
        where: { id: shipment.id },
        include: {
          trackingEvents: { orderBy: [{ eventTimeUtc: 'desc' }, { createdAt: 'desc' }] },
        },
      }),
    );
  }

  async receiveWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const config = this.readConfig(true);
    if (!rawBody?.length) {
      throw new BadRequestException('17TRACK webhook body is required.');
    }
    verifyTrack17Signature(rawBody, signature, config.apiKey);
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, any>;
    } catch {
      throw new BadRequestException('17TRACK webhook JSON is invalid.');
    }
    const eventName = cleanString(payload.event).toUpperCase();
    if (!['TRACKING_UPDATED', 'TRACKING_STOPPED'].includes(eventName)) {
      return { received: true, processed: 0 };
    }
    const records = webhookRecords(payload.data);
    let processed = 0;
    let unmatched = 0;
    for (const record of records) {
      const shipment = await this.findWebhookShipment(record);
      if (!shipment) {
        unmatched += 1;
        this.logger.warn(
          `Unmatched ${eventName} webhook for tracking number ${safeTrackingReference(record.number)}`,
        );
        continue;
      }
      await this.persistTrackingRecord(shipment, record, eventName);
      processed += 1;
    }
    this.logger.log(`${eventName}: processed=${processed} unmatched=${unmatched}`);
    return { received: true, processed, unmatched };
  }

  register(items: Track17RequestItem[]) {
    return this.apiRequest('/register', items);
  }

  getTrackInfo(items: Track17RequestItem[]) {
    return this.apiRequest('/gettrackinfo', items);
  }

  push(items: Track17RequestItem[]) {
    return this.apiRequest('/push', items);
  }

  stopTrack(items: Track17RequestItem[]) {
    return this.apiRequest('/stoptrack', items);
  }

  retrack(items: Track17RequestItem[]) {
    return this.apiRequest('/retrack', items);
  }

  private async registerNormalizedShipments(shipments: any[]) {
    const counts: RegistrationCounts = {
      accepted: 0,
      rejected: 0,
      skipped: 0,
      failed: 0,
    };
    if (!shipments.length) return counts;
    this.readConfig(true);
    const candidates: Array<{ shipment: any; request: Track17RequestItem }> = [];
    const seen = new Set<string>();
    for (const shipment of shipments) {
      if (shipment.trackingRegistrationStatus === 'REGISTERED') {
        counts.skipped += 1;
        continue;
      }
      const number = normalizeTrackingNumber(shipment.trackingNumber);
      if (!isValidTrackingNumber(number)) {
        counts.skipped += 1;
        try {
          await this.prisma.shipment.update({
            where: { id: shipment.id },
            data: {
              normalizedTrackingNumber: number || null,
              trackingRegistrationStatus: 'ERROR',
              trackingLastErrorCode: 'INVALID_TRACKING_NUMBER',
              trackingLastErrorMessage: 'Tracking number must contain 5 to 50 letters, numbers, or hyphens.',
            },
          });
        } catch (error) {
          this.logger.warn(
            `Could not save invalid tracking state for shipment ${shipment.id}: ${safeErrorMessage(error)}`,
          );
        }
        continue;
      }
      const identity = `${number}:${isValidCarrierCode(shipment.carrierCode) ? shipment.carrierCode : ''}`;
      if (seen.has(identity)) {
        counts.skipped += 1;
        continue;
      }
      seen.add(identity);
      const request: Track17RequestItem = {
        number,
        tag: shipment.publicId,
        lang: 'en',
      };
      if (isValidCarrierCode(shipment.carrierCode)) request.carrier = shipment.carrierCode;
      const orderNo = sanitizeOrderNumber(shipment.order?.externalOrderNumber);
      if (orderNo) request.order_no = orderNo;
      try {
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            normalizedTrackingNumber: number,
            trackingTag: shipment.publicId,
            trackingProvider: '17TRACK',
            trackingRegistrationStatus: 'REGISTERING',
            trackingLastRequestedAt: new Date(),
          },
        });
        candidates.push({ shipment, request });
      } catch (error) {
        counts.failed += 1;
        this.logger.warn(
          `Could not prepare shipment ${shipment.id} for registration: ${safeErrorMessage(error)}`,
        );
      }
    }

    for (const batch of chunks(candidates, 40)) {
      let response: any;
      try {
        response = await this.register(batch.map((item) => item.request));
      } catch (error) {
        counts.failed += batch.length;
        const message = safeErrorMessage(error);
        await Promise.allSettled(
          batch.map(({ shipment }) =>
            this.prisma.shipment.update({
              where: { id: shipment.id },
              data: {
                trackingRegistrationStatus: 'ERROR',
                trackingLastErrorCode: 'REQUEST_FAILED',
                trackingLastErrorMessage: message,
              },
            }),
          ),
        );
        continue;
      }
      const accepted = recordsFromData(response.data, 'accepted');
      const rejected = recordsFromData(response.data, 'rejected');
      const handledShipmentIds = new Set<string>();
      for (const item of accepted) {
        const candidate = findCandidate(batch, item);
        if (!candidate) continue;
        handledShipmentIds.add(candidate.shipment.id);
        try {
          await this.prisma.shipment.update({
            where: { id: candidate.shipment.id },
            data: {
              normalizedTrackingNumber: normalizeTrackingNumber(item.number),
              carrierCode: isValidCarrierCode(item.carrier) ? Number(item.carrier) : candidate.shipment.carrierCode,
              trackingRegistrationStatus: 'REGISTERED',
              trackingRegisteredAt: new Date(),
              trackingLastErrorCode: null,
              trackingLastErrorMessage: null,
            },
          });
          counts.accepted += 1;
        } catch (error) {
          counts.failed += 1;
          this.logger.warn(
            `Could not persist registration for shipment ${candidate.shipment.id}: ${safeErrorMessage(error)}`,
          );
        }
      }
      for (const item of rejected) {
        const candidate = findCandidate(batch, item);
        if (!candidate) continue;
        handledShipmentIds.add(candidate.shipment.id);
        try {
          if (isAlreadyRegistered(item)) {
            await this.prisma.shipment.update({
              where: { id: candidate.shipment.id },
              data: {
                carrierCode: isValidCarrierCode(item.carrier) ? Number(item.carrier) : candidate.shipment.carrierCode,
                trackingRegistrationStatus: 'REGISTERED',
                trackingRegisteredAt: candidate.shipment.trackingRegisteredAt ?? new Date(),
                trackingLastErrorCode: null,
                trackingLastErrorMessage: null,
              },
            });
            counts.accepted += 1;
            void this.refreshRegisteredCandidate(candidate.shipment.id);
          } else {
            await this.saveRegistrationError(candidate.shipment.id, item);
            counts.rejected += 1;
          }
        } catch (error) {
          counts.failed += 1;
          this.logger.warn(
            `Could not persist registration response for shipment ${candidate.shipment.id}: ${safeErrorMessage(error)}`,
          );
        }
      }
      for (const candidate of batch) {
        if (!handledShipmentIds.has(candidate.shipment.id)) {
          counts.failed += 1;
          try {
            await this.prisma.shipment.update({
              where: { id: candidate.shipment.id },
              data: {
                trackingRegistrationStatus: 'ERROR',
                trackingLastErrorCode: 'MISSING_RESPONSE',
                trackingLastErrorMessage: '17TRACK did not return a result for this tracking number.',
              },
            });
          } catch (error) {
            this.logger.warn(
              `Could not save missing response for shipment ${candidate.shipment.id}: ${safeErrorMessage(error)}`,
            );
          }
        }
      }
    }
    this.logger.log(
      `Registration accepted=${counts.accepted} rejected=${counts.rejected} skipped=${counts.skipped} failed=${counts.failed}`,
    );
    return counts;
  }

  private async refreshRegisteredCandidate(shipmentId: string) {
    try {
      const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
      if (!shipment) return;
      const item: Track17RequestItem = { number: shipment.normalizedTrackingNumber };
      if (isValidCarrierCode(shipment.carrierCode)) item.carrier = shipment.carrierCode;
      const response = await this.getTrackInfo([item]);
      const record = recordsFromData(response.data, 'accepted')[0];
      if (record) await this.persistTrackingRecord(shipment, record, 'RECOVERY_REFRESH');
    } catch {
      // Registration remains valid; a later webhook/manual refresh can recover details.
    }
  }

  private async persistTrackingRecord(shipment: any, record: Track17Record, source: string) {
    const trackInfo = record.track_info ?? {};
    const latestStatus = trackInfo.latest_status ?? {};
    const latestEvent = trackInfo.latest_event ?? null;
    const carrier = carrierDetails(record);
    const status = cleanString(latestStatus.status) || null;
    const subStatus = cleanString(latestStatus.sub_status) || null;
    const latestAt = parseDate(latestEvent?.time_utc ?? latestEvent?.time_iso);
    const delivered = isDelivered(status, subStatus, latestEvent?.stage);
    const stopped = source === 'TRACKING_STOPPED';
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.shipment.update({
        where: { id: shipment.id },
        data: {
          normalizedTrackingNumber: normalizeTrackingNumber(record.number || shipment.trackingNumber),
          carrierCode: isValidCarrierCode(record.carrier) ? Number(record.carrier) : shipment.carrierCode,
          carrierName: carrier.name || shipment.carrierName,
          trackingRegistrationStatus: 'REGISTERED',
          trackingStatus: status,
          trackingSubStatus: subStatus,
          trackingLastWebhookAt: source.startsWith('TRACKING_') ? now : shipment.trackingLastWebhookAt,
          trackingLatestEventAt: latestAt,
          trackingLatestEventDescription: cleanString(latestEvent?.description) || null,
          trackingLatestEventLocation: cleanString(latestEvent?.location) || null,
          trackingDeliveredAt: delivered ? latestAt ?? now : shipment.trackingDeliveredAt,
          trackingStoppedAt: stopped ? now : shipment.trackingStoppedAt,
          trackingLastErrorCode: null,
          trackingLastErrorMessage: null,
          trackingRawData: record,
        },
      });
      for (const event of trackingEvents(record)) {
        const data = eventData(event);
        await transaction.shipmentTrackingEvent.upsert({
          where: {
            shipmentId_fingerprint: {
              shipmentId: shipment.id,
              fingerprint: data.fingerprint,
            },
          },
          update: data,
          create: { ...data, shipmentId: shipment.id },
        });
      }
    });
  }

  private async findWebhookShipment(record: Track17Record) {
    const tag = cleanString(record.tag);
    if (tag) {
      const byTag = await this.prisma.shipment.findUnique({ where: { publicId: tag } });
      if (byTag) return byTag;
    }
    const number = normalizeTrackingNumber(record.number);
    if (!number) return null;
    return this.prisma.shipment.findFirst({
      where: {
        normalizedTrackingNumber: number,
        ...(isValidCarrierCode(record.carrier) ? { carrierCode: Number(record.carrier) } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async accessibleShipment(shipmentId: string, user: AuthenticatedUser) {
    const id = cleanString(shipmentId);
    if (!id) throw new BadRequestException('Shipment ID is required.');
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: {
        order: { select: { storeId: true, externalOrderNumber: true } },
        trackingEvents: { orderBy: [{ eventTimeUtc: 'desc' }, { createdAt: 'desc' }] },
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');
    if (
      user.role !== 'TANJAI_ADMIN' &&
      !new Set((user.storeIds ?? []).map(String)).has(shipment.order.storeId)
    ) {
      throw new ForbiddenException('You cannot access this shipment.');
    }
    return shipment;
  }

  private async saveRegistrationError(shipmentId: string, item: Track17Record) {
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        trackingRegistrationStatus: 'ERROR',
        trackingLastErrorCode: cleanString(item.error?.code) || 'REJECTED',
        trackingLastErrorMessage: sanitizeProviderMessage(item.error?.message),
      },
    });
  }

  private safeShipment(shipment: any) {
    if (!shipment) throw new NotFoundException('Shipment not found.');
    return {
      id: shipment.id,
      trackingNumber: shipment.trackingNumber,
      carrierCode: shipment.carrierCode,
      carrierName: shipment.carrierName,
      registrationStatus: shipment.trackingRegistrationStatus,
      status: shipment.trackingStatus,
      subStatus: shipment.trackingSubStatus,
      registeredAt: shipment.trackingRegisteredAt,
      latestEventAt: shipment.trackingLatestEventAt,
      latestEventDescription: shipment.trackingLatestEventDescription,
      latestEventLocation: shipment.trackingLatestEventLocation,
      deliveredAt: shipment.trackingDeliveredAt,
      lastRequestedAt: shipment.trackingLastRequestedAt,
      errorCode: shipment.trackingLastErrorCode,
      errorMessage: shipment.trackingLastErrorMessage,
      events: (shipment.trackingEvents ?? []).map((event: any) => ({
        id: event.id,
        eventTime: event.eventTime,
        eventTimeUtc: event.eventTimeUtc,
        description: event.description,
        translatedDescription: event.translatedDescription,
        location: event.location,
        stage: event.stage,
        subStatus: event.subStatus,
        country: event.country,
        state: event.state,
        city: event.city,
        postalCode: event.postalCode,
      })),
    };
  }

  private async apiRequest(path: string, body: Track17RequestItem[]) {
    if (!Array.isArray(body) || body.length < 1 || body.length > 40) {
      throw new BadRequestException('17TRACK requests require between 1 and 40 tracking numbers.');
    }
    const config = this.readConfig(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.scheduledFetch(`${config.baseUrl}${path}`, {
        method: 'POST',
        headers: { '17token': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429 && attempt < 2) {
        await delay(400 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw new BadGatewayException(
          response.status === 429
            ? '17TRACK rate limit was reached. Try again shortly.'
            : `17TRACK request failed with status ${response.status}.`,
        );
      }
      let result: any;
      try {
        result = await response.json();
      } catch {
        throw new BadGatewayException('17TRACK returned malformed JSON.');
      }
      if (Number(result?.code) !== 0) {
        throw new BadGatewayException(
          `17TRACK rejected the request${result?.code !== undefined ? ` (code ${String(result.code)})` : ''}.`,
        );
      }
      return result;
    }
    throw new BadGatewayException('17TRACK request failed after retrying.');
  }

  private scheduledFetch(url: string, init: RequestInit) {
    const run = this.requestQueue.then(async () => {
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs) await delay(waitMs);
      this.nextRequestAt = Date.now() + 334;
      try {
        return await fetch(url, init);
      } catch {
        throw new BadGatewayException('Unable to reach 17TRACK.');
      }
    });
    this.requestQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private isConfigured() {
    const config = this.readConfig(false);
    return Boolean(config.enabled && config.apiKey && config.baseUrl);
  }

  private readConfig(required: boolean): Track17Config {
    const enabled = (process.env.TRACK17_ENABLED ?? 'false').trim().toLowerCase() === 'true';
    const apiKey = process.env.TRACK17_API_KEY?.trim() ?? '';
    const baseUrl = (process.env.TRACK17_API_BASE_URL?.trim() ?? 'https://api.17track.net/track/v2.4').replace(/\/$/, '');
    const webhookUrl = process.env.TRACK17_WEBHOOK_URL?.trim() ?? '';
    if (required && (!enabled || !apiKey || !baseUrl)) {
      throw new ServiceUnavailableException('17TRACK integration is not configured.');
    }
    return { enabled, apiKey, baseUrl, webhookUrl };
  }
}

function normalizeTrackingNumber(value: unknown) {
  return cleanString(value).toUpperCase().replace(/\s+/g, '');
}

function isValidTrackingNumber(value: string) {
  return /^(?!PENDING-?TRACKING$)[A-Z0-9-]{5,50}$/.test(value);
}

function isValidCarrierCode(value: unknown): value is number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function sanitizeOrderNumber(value: unknown) {
  const sanitized = cleanString(value).replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized ? sanitized.slice(0, 64) : '';
}

function cleanString(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function recordsFromData(data: any, key: 'accepted' | 'rejected'): Track17Record[] {
  return Array.isArray(data?.[key]) ? data[key] : [];
}

function webhookRecords(data: any): Track17Record[] {
  if (Array.isArray(data?.accepted)) return data.accepted;
  if (Array.isArray(data)) return data;
  return data && typeof data === 'object' ? [data] : [];
}

function requestIdentity(item: Track17RequestItem) {
  return `${normalizeTrackingNumber(item.number)}:${isValidCarrierCode(item.carrier) ? item.carrier : ''}`;
}

function responseIdentity(item: Track17Record) {
  return `${normalizeTrackingNumber(item.number)}:${isValidCarrierCode(item.carrier) ? item.carrier : ''}`;
}

function findCandidate(batch: Array<{ shipment: any; request: Track17RequestItem }>, item: Track17Record) {
  const exact = batch.find((candidate) => requestIdentity(candidate.request) === responseIdentity(item));
  return exact ?? batch.find((candidate) => normalizeTrackingNumber(candidate.request.number) === normalizeTrackingNumber(item.number));
}

function isAlreadyRegistered(item: Track17Record) {
  const message = cleanString(item.error?.message).toLowerCase();
  return message.includes('already') && message.includes('register');
}

function sanitizeProviderMessage(value: unknown) {
  const message = cleanString(value).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
  return message || '17TRACK rejected this tracking number.';
}

function safeErrorMessage(error: unknown) {
  if (error instanceof ServiceUnavailableException) return '17TRACK is not configured.';
  if (error instanceof Error && error.message.startsWith('17TRACK')) return error.message.slice(0, 300);
  return '17TRACK registration failed.';
}

function safeTrackingReference(value: unknown) {
  const normalized = normalizeTrackingNumber(value);
  if (normalized.length <= 6) return normalized || 'unknown';
  return `${normalized.slice(0, 3)}…${normalized.slice(-3)}`;
}

function carrierDetails(record: Track17Record) {
  const providers = Array.isArray(record.track_info?.tracking?.providers)
    ? record.track_info.tracking.providers
    : [];
  const carrierCode = Number(record.carrier);
  const matched = providers.find((item: any) => Number(item?.provider?.key) === carrierCode) ?? providers[0];
  return { name: cleanString(matched?.provider?.name) || null };
}

function trackingEvents(record: Track17Record) {
  const providers = Array.isArray(record.track_info?.tracking?.providers)
    ? record.track_info.tracking.providers
    : [];
  return providers.flatMap((provider: any) => Array.isArray(provider?.events) ? provider.events : []);
}

function eventData(event: any) {
  const translated = event?.description_translation;
  const relevant = {
    time: cleanString(event?.time_iso),
    timeUtc: cleanString(event?.time_utc),
    description: cleanString(event?.description),
    location: cleanString(event?.location),
    stage: cleanString(event?.stage),
    subStatus: cleanString(event?.sub_status),
  };
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(relevant)).digest('hex'),
    eventTime: parseDate(event?.time_iso),
    eventTimeUtc: parseDate(event?.time_utc),
    description: relevant.description || null,
    translatedDescription: cleanString(translated?.description) || null,
    location: relevant.location || null,
    stage: relevant.stage || null,
    subStatus: relevant.subStatus || null,
    country: cleanString(event?.address?.country) || null,
    state: cleanString(event?.address?.state) || null,
    city: cleanString(event?.address?.city) || null,
    postalCode: cleanString(event?.address?.postal_code) || null,
    rawData: event,
  };
}

function parseDate(value: unknown) {
  const text = cleanString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isDelivered(...values: unknown[]) {
  return values.some((value) => cleanString(value).toLowerCase().includes('delivered'));
}

function verifyTrack17Signature(rawBody: Buffer, signature: string | undefined, apiKey: string) {
  const expected = createHash('sha256')
    .update(Buffer.concat([rawBody, Buffer.from(`/${apiKey}`, 'utf8')]))
    .digest('hex');
  const provided = cleanString(signature).toLowerCase();
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new ForbiddenException('17TRACK webhook signature is invalid.');
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
