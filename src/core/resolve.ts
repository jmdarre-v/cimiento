// Deferred value resolution.
//
// Non secret outputs live in the project state and survive between runs. Secret outputs, such as a
// database service role key, must never be written to state, so they are held in memory for the
// length of one run and re fetched from the producing provider when a later run needs them.

import { outputFromState, splitRef, type ProjectState } from './state'
import { isDeferred, type Ctx, type Output, type Provider, type ResourceSpec } from './types'

export class OutputResolver {
  private live = new Map<string, string>()
  private hydrated = new Set<string>()

  constructor(private state: ProjectState) {}

  useState(state: ProjectState): void {
    this.state = state
  }

  /** Keeps every output of a step in memory, including the secret ones state cannot hold. */
  record(specId: string, outputs: Record<string, Output> | undefined, ctx?: Ctx): void {
    for (const [key, output] of Object.entries(outputs ?? {})) {
      if (output.value === undefined) continue
      this.live.set(`${specId}:${key}`, output.value)
      if (output.secret) ctx?.redactor.addValue(output.value)
    }
    this.hydrated.add(specId)
  }

  get(ref: string): string | undefined {
    const live = this.live.get(ref)
    if (live !== undefined) return live
    return outputFromState(this.state, ref)
  }

  /** Asks the producing provider for its outputs, for refs state cannot answer. */
  async hydrate(
    ref: string,
    specs: ResourceSpec[],
    providers: Map<string, Provider>,
    ctx: Ctx,
  ): Promise<void> {
    const producerId = splitRef(ref)[0]
    if (this.hydrated.has(producerId)) return
    const producer = specs.find((s) => s.id === producerId)
    if (!producer) return
    const provider = providers.get(producer.provider)
    if (!provider) return
    const { spec } = this.resolve(producer)
    this.hydrated.add(producerId)
    try {
      this.record(producerId, await provider.outputs(spec, ctx), ctx)
    } catch {
      // A provider that cannot answer leaves the ref unresolved, which the caller reports.
    }
  }

  resolve(spec: ResourceSpec): { spec: ResourceSpec; unresolved: string[] } {
    const inputs: Record<string, string | { deferred: string }> = {}
    const unresolved: string[] = []
    for (const [key, value] of Object.entries(spec.inputs)) {
      if (!isDeferred(value)) {
        inputs[key] = value
        continue
      }
      const resolved = this.get(value.deferred)
      if (resolved === undefined) {
        unresolved.push(value.deferred)
        inputs[key] = value
      } else {
        inputs[key] = resolved
      }
    }
    return { spec: { ...spec, inputs }, unresolved }
  }

  /** Resolves, then tries one hydration pass for anything still missing. */
  async resolveWithHydration(
    spec: ResourceSpec,
    specs: ResourceSpec[],
    providers: Map<string, Provider>,
    ctx: Ctx,
  ): Promise<{ spec: ResourceSpec; unresolved: string[] }> {
    let attempt = this.resolve(spec)
    if (attempt.unresolved.length === 0) return attempt
    for (const ref of attempt.unresolved) {
      await this.hydrate(ref, specs, providers, ctx)
    }
    attempt = this.resolve(spec)
    return attempt
  }
}
