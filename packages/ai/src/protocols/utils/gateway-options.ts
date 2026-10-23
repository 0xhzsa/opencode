export interface GatewayOptions {
  /** Service-owned options added by the Gateway without requiring an SDK update. */
  readonly [key: string]: unknown
  /** Enables Gateway automatic prompt-cache breakpoint injection (`"auto"`). */
  readonly caching?: "auto" | (string & {})
  /** Provider slugs that are the only ones allowed to serve the request (e.g. `["anthropic", "vertex"]`). */
  readonly only?: ReadonlyArray<string>
  /** Provider slugs specifying the order in which providers are tried (e.g. `["bedrock", "anthropic"]`). */
  readonly order?: ReadonlyArray<string>
  /** Sort candidate providers by cost (`"cost"`), throughput (`"tps"`), or time-to-first-token (`"ttft"`). */
  readonly sort?: "cost" | "tps" | "ttft" | (string & {})
  /** Fallback models to try in order, or a conditional `{ model, when }` entry on evaluation requests. */
  readonly models?: ReadonlyArray<string | Readonly<Record<string, unknown>>>
  /** Restrict routing to providers with zero data retention agreements. */
  readonly zeroDataRetention?: boolean
  /** Restrict routing to providers that do not train on prompt data. */
  readonly disallowPromptTraining?: boolean
  /**
   * Restrict routing to provider models that satisfy every entry: capability
   * tags (`"implicit-caching"`, `"reasoning"`, `"structured-output"`,
   * `"tool-use"`, `"vision"`) or weight-format filters (`"quantization:fp8"`,
   * `"!quantization:fp8"`).
   */
  readonly has?: ReadonlyArray<
    | "implicit-caching"
    | "reasoning"
    | "structured-output"
    | "tool-use"
    | "vision"
    | `quantization:${string}`
    | `!quantization:${string}`
    | (string & {})
  >
  /** Entity identifier against which Gateway quota is tracked. */
  readonly quotaEntityId?: string
  /** Unified service tier intent (`"flex"` or `"priority"`). */
  readonly serviceTier?: "flex" | "priority" | (string & {})
  /** End-user identifier for spend tracking and attribution. */
  readonly user?: string
  /** User-specified tags for reporting and filtering usage. */
  readonly tags?: ReadonlyArray<string>
  /** Request-scoped BYOK credentials keyed by provider slug, used instead of cached workspace credentials. */
  readonly byok?: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>
  /** Preferred inference region for upstream provider routing. */
  readonly inferenceRegion?: string
  /** Per-provider timeouts in milliseconds (e.g. `{ byok: { anthropic: 3000 } }`). */
  readonly providerTimeouts?: {
    readonly [key: string]: unknown
    readonly byok?: Readonly<Record<string, number>>
  }
}
