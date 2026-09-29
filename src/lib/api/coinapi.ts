const COINAPI_BASE = 'https://rest.coinapi.io/v1';

export interface CoinApiExchangeRate {
  asset_id_base: string;
  asset_id_quote: string;
  rate: number;
  time: string;
}

export interface CoinApiTimeSeries {
  time_period_start: string;
  time_period_end: string;
  rate_open: number;
  rate_high: number;
  rate_low: number;
  rate_close: number;
}

async function coinApiFetch<T>(path: string): Promise<T> {
  const COINAPI_KEY = process.env.COINAPI_KEY;
  if (!COINAPI_KEY) {
    throw new Error('CoinAPI key is not configured');
  }

  const response = await fetch(`${COINAPI_BASE}${path}`, {
    headers: {
      'X-CoinAPI-Key': COINAPI_KEY,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`CoinAPI error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function getCurrentRunePrice(): Promise<number | null> {
  try {
    const data = await coinApiFetch<CoinApiExchangeRate>('/exchangerate/RUNE/USD');
    return data.rate;
  } catch (error) {
    console.error('CoinAPI fetch error:', error);
    return null;
  }
}

export async function getRunePriceAtDate(targetDate: Date): Promise<number | null> {
  const dateStr = targetDate.toISOString().slice(0, 10);
  const nextDay = new Date(targetDate);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const dateEnd = nextDay.toISOString().slice(0, 10);

  try {
    const data = await coinApiFetch<CoinApiTimeSeries[]>(
      `/exchangerate/RUNE/USD/history?time_start=${dateStr}T00:00:00Z&time_end=${dateEnd}T00:00:00Z&period_id=1DAY&limit=1`
    );

    if (data && data.length > 0) {
      return data[0].rate_close;
    }
    return null;
  } catch (error) {
    console.error('CoinAPI historical price fetch error:', error);
    return null;
  }
}

export async function getRunePriceRange(
  timeStart: string,
  timeEnd: string
): Promise<CoinApiTimeSeries[]> {
  const start = new Date(timeStart);
  const end = new Date(timeEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error('Invalid CoinAPI date range');
  }

  const maxRangeMs = 370 * 24 * 60 * 60 * 1000;
  if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > maxRangeMs) {
    throw new Error('CoinAPI date range must be positive and no longer than 370 days');
  }

  try {
    const params = new URLSearchParams({
      time_start: start.toISOString(),
      time_end: end.toISOString(),
      period_id: '1DAY',
    });
    return await coinApiFetch<CoinApiTimeSeries[]>(`/exchangerate/RUNE/USD/history?${params.toString()}`);
  } catch (error) {
    console.error('CoinAPI range fetch error:', error);
    return [];
  }
}
