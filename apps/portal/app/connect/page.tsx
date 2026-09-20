import { requireChatGPTUser } from '../chatgpt-auth';
import Connect from './view';
export const dynamic = 'force-dynamic';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code = '' } = await searchParams;
  return <SignedIn code={code} />;
}
async function SignedIn({ code }: { code: string }) {
  await requireChatGPTUser(`/connect?code=${encodeURIComponent(code)}`);
  return <Connect code={code} />;
}
