export function takeBounded<T>(
  source: ArrayLike<T> | Iterable<T>,
  limit: number,
): T[] {
  return [...iterateBounded(source, limit)];
}

export function* iterateBounded<T>(
  source: ArrayLike<T> | Iterable<T>,
  limit: number,
): IterableIterator<T> {
  if (limit <= 0) {
    return;
  }

  if (isIterable(source)) {
    let count = 0;
    for (const item of source) {
      yield item;
      count += 1;
      if (count >= limit) {
        return;
      }
    }
    return;
  }

  const length = boundedLength(source.length, limit);
  for (let index = 0; index < length; index += 1) {
    yield source[index]!;
  }
}

export function* enumerateBounded<T>(
  source: ArrayLike<T> | Iterable<T>,
  limit: number,
): IterableIterator<readonly [number, T]> {
  let index = 0;
  for (const item of iterateBounded(source, limit)) {
    yield [index, item] as const;
    index += 1;
  }
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

export function joinBounded(
  values: readonly string[],
  limit: number,
): string {
  let result = "";
  for (const value of values) {
    const remaining = limit - result.length;
    if (remaining <= 0) {
      break;
    }
    result += truncate(value, remaining);
  }
  return result;
}

export function boundedLength(value: number, limit: number): number {
  if (Number.isNaN(value) || value <= 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    return limit;
  }
  return Math.min(Math.floor(value), limit);
}

function isIterable<T>(
  source: ArrayLike<T> | Iterable<T>,
): source is Iterable<T> {
  return typeof (source as Partial<Iterable<T>>)[Symbol.iterator] === "function";
}
