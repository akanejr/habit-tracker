import { notFound } from 'next/navigation';
import { SessionsWorkspace } from '@/components/sessions/sessions-workspace';

/** Explicit opt-in demo only. It never connects to or writes to a Supabase database. */
export const dynamic = 'force-dynamic';
export default function PhaseOneDemo() {
  if (process.env.BLOOM_PHASE1_DEMO !== '1') notFound();
  return <SessionsWorkspace userId="phase1-synthetic-user" demo />;
}
