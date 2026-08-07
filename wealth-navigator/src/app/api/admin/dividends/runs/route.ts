import { NextResponse } from 'next/server';
import { getRuns, getStats } from '@/lib/dividends-db';

export async function GET() {
  try {
    const [runs, stats] = await Promise.all([getRuns(50), getStats()]);
    return NextResponse.json({ ok: true, runs, stats });
  } catch (err: any) {
    console.error('[dividends-runs]', err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
