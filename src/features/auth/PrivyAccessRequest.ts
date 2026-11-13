export type VersionedRequest<T> = {
  version: number
  promise: Promise<T>
}

/** Join an active check for the same session/identity pair; newer checks fence older results. */
export function startOrJoinVersionedRequest<T>(
  requests: Map<string, VersionedRequest<T>>,
  versionCounter: { current: number },
  key: string,
  run: (version: number) => Promise<T>,
): Promise<T> {
  const active = requests.get(key)
  if (active?.version === versionCounter.current) return active.promise

  const version = ++versionCounter.current
  const request: VersionedRequest<T> = {
    version,
    promise: Promise.resolve().then(() => run(version)),
  }
  requests.set(key, request)

  const removeIfCurrent = () => {
    if (requests.get(key) === request) requests.delete(key)
  }
  void request.promise.then(removeIfCurrent, removeIfCurrent)
  return request.promise
}
