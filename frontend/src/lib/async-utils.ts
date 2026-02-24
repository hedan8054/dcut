/** 限制并发数的批处理执行器 */
export async function runWithLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (idx < items.length) {
        const cur = items[idx++]
        await worker(cur)
      }
    },
  )
  await Promise.all(runners)
}
