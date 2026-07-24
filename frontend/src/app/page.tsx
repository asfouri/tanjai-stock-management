import { redirect } from "next/navigation";

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps) {
  const values = await searchParams;
  if (values.shop && values.hmac && values.timestamp) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (Array.isArray(value)) {
        for (const item of value) query.append(key, item);
      } else if (value !== undefined) {
        query.set(key, value);
      }
    }
    redirect(`/shopify/launch?${query.toString()}`);
  }
  redirect("/login");
}
