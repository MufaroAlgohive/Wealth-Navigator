import { NextResponse } from 'next/server';
import { getPayouts } from '@/lib/dividends-db';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get('run_id');
    const rawLim = Number(searchParams.get('limit') || 2000);
    const limit = Number.isFinite(rawLim) && rawLim > 0 ? Math.min(rawLim, 5000) : 2000;

    if (!runId || isNaN(Number(runId))) {
      return NextResponse.json({ ok: false, error: 'run_id required' }, { status: 400 });
    }

    const payouts = await getPayouts(Number(runId), limit);
    return NextResponse.json({ ok: true, run_id: Number(runId), payouts });
  } catch (err: any) {
    console.error('[dividends-payouts]', err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
