import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

loadLocalEnv();

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TANJAI_ADMIN_EMAIL",
  "TANJAI_ADMIN_PASSWORD",
  "BRAND_OWNER_EMAIL",
  "BRAND_OWNER_PASSWORD",
  "UFULFILL_EMAIL",
  "UFULFILL_PASSWORD",
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`Missing environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const devUsers = [
  {
    label: "TanjAI Admin",
    first_name: "TanjAI",
    last_name: "Admin",
    role: "TANJAI_ADMIN",
    email: process.env.TANJAI_ADMIN_EMAIL,
    password: process.env.TANJAI_ADMIN_PASSWORD,
  },
  {
    label: "Brand Owner",
    first_name: "Brand",
    last_name: "Owner",
    role: "BRAND_OWNER",
    email: process.env.BRAND_OWNER_EMAIL,
    password: process.env.BRAND_OWNER_PASSWORD,
  },
  {
    label: "UFulfill",
    first_name: "UFulfill",
    last_name: "User",
    role: "UFULFILL",
    email: process.env.UFULFILL_EMAIL,
    password: process.env.UFULFILL_PASSWORD,
  },
];

async function requestJson(path, options = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${responseText}`);
  }

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(
      `${options.method ?? "GET"} ${path} returned invalid JSON: ${responseText}`
    );
  }
}

async function findUserByEmail(email) {
  const data = await requestJson("/auth/v1/admin/users?page=1&per_page=1000");
  const users = Array.isArray(data) ? data : data.users ?? [];

  return users.find(
    (user) => user.email?.toLowerCase() === email.toLowerCase()
  );
}

async function upsertAuthUser(devUser) {
  const existingUser = await findUserByEmail(devUser.email);
  const body = {
    email: devUser.email,
    password: devUser.password,
    email_confirm: true,
    user_metadata: {
      first_name: devUser.first_name,
      last_name: devUser.last_name,
      role: devUser.role,
    },
  };

  if (existingUser) {
    const updatedUser = await requestJson(
      `/auth/v1/admin/users/${existingUser.id}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );

    return updatedUser?.user ?? updatedUser ?? existingUser;
  }

  const createdUser = await requestJson("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return createdUser.user ?? createdUser;
}

async function upsertProfile(userId, devUser) {
  await requestJson("/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([
      {
        id: userId,
        first_name: devUser.first_name,
        last_name: devUser.last_name,
        email: devUser.email,
        role: devUser.role,
        is_active: true,
      },
    ]),
  });
}

for (const devUser of devUsers) {
  const authUser = await upsertAuthUser(devUser);
  await upsertProfile(authUser.id, devUser);
  console.log(`Seeded ${devUser.label} (${devUser.role})`);
}
