import { LoginClient } from "@/features/auth/components/LoginClient";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const initialEmail = firstParam(params.email).trim();
  const message = firstParam(params.message);

  return <LoginClient initialEmail={initialEmail} initialMessage={message} />;
}
