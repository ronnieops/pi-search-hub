/**
 * DuckDuckGo search backend — free, no key needed.
 * Spawns Python subprocess using the ddgs library (v9.x metasearch).
 *
 * ddgs v9.x supports:
 *   - backend: "auto" | "bing" | "brave" | "duckduckgo" | "google" | "yandex" | etc. (comma-delimited)
 *   - region: "us-en", "uk-en", etc.
 *   - timelimit: "d" | "w" | "m" | "y" for recency
 *   - safesearch: "on" | "moderate" | "off"
 */

import { spawn } from "node:child_process";
import { HTTP_TIMEOUT_MS } from "../utils.js";
import type { SearchResult } from "../types.js";

export interface DuckDuckGoOptions {
	/** ddgs backend(s): "auto", "duckduckgo", "bing", "brave", "google", comma-delimited. Default: "auto" */
	backend?: string;
	/** Region: "us-en", "uk-en", etc. Default: "us-en" */
	region?: string;
	/** Time limit: "d" (day), "w" (week), "m" (month), "y" (year). Default: none */
	timelimit?: string;
	/** Safe search: "on", "moderate", "off". Default: "moderate" */
	safesearch?: string;
}

export async function searchDuckDuckGo(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	options?: DuckDuckGoOptions,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) throw new Error("DuckDuckGo search aborted");

	const backend = options?.backend || "auto";
	const region = options?.region || "us-en";
	const timelimit = options?.timelimit || "";
	const safesearch = options?.safesearch || "moderate";

	const pyScript = `
import json, sys
try:
    from ddgs import DDGS
except ImportError as e:
    # Detect missing ddgs specifically — give actionable install instructions
    if "ddgs" in str(e):
        print("DuckDuckGo backend requires the ddgs Python package. Install with: pip3 install ddgs", file=sys.stderr)
        sys.exit(1)
    # ddgs may be installed as a uv tool — find it and add to sys.path
    import subprocess, pathlib
    try:
        ddgs_bin = subprocess.check_output(["which", "ddgs"], text=True, stderr=subprocess.DEVNULL).strip()
        if ddgs_bin:
            # Walk up from the binary until we find site-packages — no hardcoded depth assumption
            ddgs_path = pathlib.Path(ddgs_bin).resolve()
            found = False
            for parent in [ddgs_path, *ddgs_path.parents]:
                for py_ver_dir in sorted((parent / "lib").iterdir(), reverse=True):
                    sp = py_ver_dir / "site-packages"
                    if sp.is_dir():
                        sys.path.insert(0, str(sp))
                        found = True
                        break
                if found:
                    break
            if not found:
                print(f"ddgs import failed, path search failed: {e}", file=sys.stderr)
                sys.exit(1)
    except Exception as ex:
        print(f"ddgs import failed: {e}, path search failed: {ex}", file=sys.stderr)
        sys.exit(1)
    from ddgs import DDGS

results = []
error_msg = None
try:
    with DDGS() as ddgs:
        kwargs = {"query": ${JSON.stringify(query)}, "max_results": ${numResults}, "backend": ${JSON.stringify(backend)}, "region": ${JSON.stringify(region)}, "safesearch": ${JSON.stringify(safesearch)}}
        ${timelimit ? `kwargs["timelimit"] = ${JSON.stringify(timelimit)}` : ""}
        for i, r in enumerate(ddgs.text(**kwargs)):
            results.append({"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")})
except Exception as ex:
    error_msg = f"{type(ex).__name__}: {ex}"

if error_msg:
    print(error_msg, file=sys.stderr)
    sys.exit(1)

print(json.dumps({"results": results}))
`;

	return new Promise((resolve, reject) => {
		const pythonCmd = process.platform === "win32" ? "python" : "python3";
		const proc = spawn(pythonCmd, ["-c", pyScript], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
		proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

		// Timeout timer
		const timeout = setTimeout(() => {
			proc.kill();
			reject(new Error("DuckDuckGo search timed out (30s)"));
		}, HTTP_TIMEOUT_MS);

		// Abort signal handler
		const onAbort = () => {
			clearTimeout(timeout);
			proc.kill();
			reject(new Error("DuckDuckGo search aborted"));
		};
		if (signal) {
			if (signal.aborted) { clearTimeout(timeout); reject(new Error("DuckDuckGo search aborted")); return; }
			signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (code === 0) {
				try {
					resolve(JSON.parse(stdout.trim()));
				} catch {
					reject(new Error(`DuckDuckGo: invalid JSON (exit ${code}): ${stdout.slice(0, 200)}`));
				}
			} else {
				const stderrMsg = stderr.trim();
				const stdoutSample = stdout.trim().slice(0, 100);
				// Provide diagnostic info when stderr is empty
				const diagnostic = stderrMsg || (stdoutSample ? `no stderr, stdout sample: ${stdoutSample}` : "unknown error");
				reject(new Error(`DuckDuckGo failed (exit ${code}): ${diagnostic}`));
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(new Error(`DuckDuckGo spawn error: ${err.message}`));
		});
	});
}
