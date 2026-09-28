import { providerOf, type ProviderName } from './provider.js';
import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /**
   * `typesafe` posts to api.typesafe.ai. `openrouter` posts to
   * openrouter.ai/api/v1/systemone. The body is the same System One request.
   * Default `typesafe`.
   */
  provider?: ProviderName;
  /** Defaults to the provider's env var (`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`). */
  apiKey?: string;
  /** Defaults to `jev-latest`. OpenRouter maps that name onto its TypeSafe alias. */
  model?: string;
  /** Overrides the provider endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly envKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    const provider = providerOf(options.provider);
    this.envKey = provider.envKey;
    this.apiKey = options.apiKey ?? process.env[provider.envKey] ?? '';
    this.model = options.model ?? provider.defaultModel;
    this.baseUrl = options.baseUrl ?? provider.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(`${this.envKey} is not configured`);
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
