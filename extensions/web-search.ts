/**
 * Web Search Extension (global)
 *
 * Registers a `web_search` tool available in every project.
 *
 * Backends, tried in order:
 *   1. BRAVE_API_KEY env var  → Brave Search API (clean JSON, free tier)
 *   2. TAVILY_API_KEY env var → Tavily Search API (AI-oriented, free tier)
 *   3. DuckDuckGo HTML        → no key required (unofficial endpoint)
 *
 * For full page content after searching, the agent can just use bash:
 *   curl -sL <url> | head -c 20000
 */

import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const UA = `pi-web-search/1.0 (${os.platform()}; node ${process.version})`;

// ── backends ────────────────────────────────────────────────────

async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
	const key = process.env.BRAVE_API_KEY;
	if (!key) throw new Error("no key");
	const res = await fetch(
		`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
		{ headers: { Accept: "application/json", "X-Subscription-Token": key } },
	);
	if (!res.ok) throw new Error(`Brave API ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
	return (data.web?.results ?? []).slice(0, count).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

async function tavilySearch(query: string, count: number): Promise<SearchResult[]> {
	const key = process.env.TAVILY_API_KEY;
	if (!key) throw new Error("no key");
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({ query, max_results: count }),
	});
	if (!res.ok) throw new Error(`Tavily API ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
	return (data.results ?? []).slice(0, count).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: (r.content ?? "").slice(0, 300),
	}));
}

function decodeDdgHref(href: string): string {
	if (href.startsWith("//")) href = `https:${href}`;
	try {
		const u = new URL(href);
		const uddg = u.searchParams.get("uddg");
		if (uddg) return uddg;
	} catch {
		/* not a URL */
	}
	return href;
}

async function ddgSearch(query: string, count: number): Promise<SearchResult[]> {
	const res = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
		body: `q=${encodeURIComponent(query)}`,
	});
	if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
	const html = await res.text();
	const out: SearchResult[] = [];
	// Results come in pairs: title link, then snippet link.
	const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) && out.length < count) {
		if (m[1] !== undefined) {
			out.push({ title: stripTags(m[2]), url: decodeDdgHref(m[1]), snippet: "" });
		} else if (m[3] !== undefined && out.length > 0) {
			out[out.length - 1].snippet = stripTags(m[3]).slice(0, 300);
		}
	}
	return out;
}

function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
}

export async function webSearch(query: string, count = 5): Promise<{ backend: string; results: SearchResult[] }> {
	const backends: [string, (q: string, c: number) => Promise<SearchResult[]>][] = [
		["brave", braveSearch],
		["tavily", tavilySearch],
		["duckduckgo", ddgSearch],
	];
	let lastErr: unknown;
	for (const [name, fn] of backends) {
		try {
			const results = await fn(query, count);
			if (results.length > 0 || name === "duckduckgo") return { backend: name, results };
			lastErr = new Error("no results");
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(`all search backends failed: ${String(lastErr)}`);
}

// ── tool ────────────────────────────────────────────────────────

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. Returns titles, URLs and snippets. Use for current events, documentation, or anything beyond local files. For full page content, fetch the URL with bash curl afterwards.",
		promptSnippet: "web_search — search the web (titles/URLs/snippets)",
		parameters: WebSearchParams,
		executionMode: "parallel",

		async execute(_id, params, signal) {
			const { backend, results } = await webSearch(params.query, Math.min(Math.max(1, params.count ?? 5), 10));
			if (signal?.aborted) throw new Error("aborted");
			if (results.length === 0) {
				return { content: [{ type: "text", text: `No results for "${params.query}"` }], details: undefined };
			}
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n\n");
			return { content: [{ type: "text", text: `Web search results (${backend}) for "${params.query}":\n\n${text}` }], details: undefined };
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("muted", `"${args.query}"`), 0, 0);
		},

		renderResult(result, _opts, theme) {
			const t = result.content[0];
			return new Text(theme.fg("muted", (t?.type === "text" ? t.text : "").slice(0, 500)), 0, 0);
		},
	});
}
