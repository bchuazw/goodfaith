// Real-world corpus: publicly disclosed curl reports, checked against the real curl source.
//
// The 10 slop reports are the AI-generated HackerOne reports Daniel Stenberg listed in "Death by a
// thousand slops" (https://daniel.haxx.se/blog/2025/07/14/death-by-a-thousand-slops/). The 5 control
// reports are real, published curl CVEs. We store only the minimal claim text needed plus a source
// URL; each report's cited code reference is mapped to a concrete curl file/symbol so the
// deterministic code-reference check can confirm whether it exists at the cited version.
//
// Finding (verified against the curl source): most disclosed AI-slop cites REAL curl code — that is
// exactly why it wastes maintainer time and cannot be auto-dismissed; a subset references code curl
// does not have. The goal here is the control property: no real CVE report is ever flagged SLOP.

import type { ReportInput } from "@goodfaith/core";

export interface CurlCase {
  id: string;
  kind: "slop" | "cve";
  source: string;
  /** Short human note on how the public claim maps to a concrete curl reference. */
  mapping: string;
  report: ReportInput;
}

function mk(id: string, over: Partial<ReportInput> & { title: string; body: string; claimedVersion: string }): ReportInput {
  return {
    id,
    programId: "curl",
    reporter: { handle: "disclosed" },
    submittedAt: "2025-07-01T00:00:00.000Z",
    ...over,
  };
}

export const CURL_CASES: CurlCase[] = [
  // ---- AI-slop reports (from "Death by a thousand slops") ----
  {
    id: "slop_h1_2819666_mfprintf",
    kind: "slop",
    source: "https://hackerone.com/reports/2819666",
    mapping: "Names a real function, curl_mfprintf() in lib/mprintf.c; the 'format string' bug is fabricated.",
    report: mk("slop_h1_2819666_mfprintf", { title: "Exploitable Format String Vulnerability in curl_mfprintf Function", claimedVersion: "8.8.0", body: "A format string vulnerability in curl_mfprintf() in lib/mprintf.c allows remote code execution." }),
  },
  {
    id: "slop_h1_2887487_inet_ntop",
    kind: "slop",
    source: "https://hackerone.com/reports/2887487",
    mapping: "Names real functions, Curl_inet_ntop() in lib/inet_ntop.c; the overflow is fabricated.",
    report: mk("slop_h1_2887487_inet_ntop", { title: "Buffer Overflow Risk in Curl_inet_ntop and inet_ntop4", claimedVersion: "8.8.0", body: "A buffer overflow in Curl_inet_ntop() in lib/inet_ntop.c can be triggered remotely." }),
  },
  {
    id: "slop_h1_3117697_cookie",
    kind: "slop",
    source: "https://hackerone.com/reports/3117697",
    mapping: "Cites the real file lib/cookie.c; the double free is fabricated.",
    report: mk("slop_h1_3117697_cookie", { title: "Double Free Vulnerability in libcurl Cookie Management (cookie.c)", claimedVersion: "8.9.0", body: "A double free in cookie management in lib/cookie.c leads to memory corruption." }),
  },
  {
    id: "slop_h1_3101127_mqttd",
    kind: "slop",
    source: "https://hackerone.com/reports/3101127",
    mapping: "Cites a real test file, tests/server/mqttd.c; the overflow is fabricated (and it is test-only code).",
    report: mk("slop_h1_3101127_mqttd", { title: "Buffer Overflow in curl MQTT Test Server via CONNECT Packet", claimedVersion: "8.9.0", body: "A malicious MQTT CONNECT packet overflows a buffer in tests/server/mqttd.c." }),
  },
  {
    id: "slop_h1_3230082_telnet",
    kind: "slop",
    source: "https://hackerone.com/reports/3230082",
    mapping: "Cites the real file lib/telnet.c (TELNET NEW_ENV handling); the stack overflow is fabricated.",
    report: mk("slop_h1_3230082_telnet", { title: "Stack-based Buffer Overflow in TELNET NEW_ENV Option Handling", claimedVersion: "8.11.0", body: "TELNET NEW_ENV option handling in lib/telnet.c has a stack-based buffer overflow." }),
  },
  {
    id: "slop_h1_3242005_keylog",
    kind: "slop",
    source: "https://hackerone.com/reports/3242005",
    mapping: "Cites the real file lib/vtls/openssl.c and the OpenSSL API SSL_get_ex_data; the UAF is fabricated.",
    report: mk("slop_h1_3242005_keylog", { title: "Use-After-Free in OpenSSL Keylog Callback via SSL_get_ex_data()", claimedVersion: "8.11.0", body: "A use-after-free in the OpenSSL keylog callback via SSL_get_ex_data in lib/vtls/openssl.c." }),
  },
  {
    id: "slop_h1_3100073_ipfs",
    kind: "slop",
    source: "https://hackerone.com/reports/3100073",
    mapping: "The IPFS_PATH handling is real, in src/tool_ipfs.c; the path traversal is fabricated.",
    report: mk("slop_h1_3100073_ipfs", { title: "Path Traversal via Unsanitized IPFS_PATH Environment Variable", claimedVersion: "8.11.0", body: "The IPFS_PATH environment variable handling in src/tool_ipfs.c allows path traversal." }),
  },
  {
    id: "slop_h1_3125832_http3",
    kind: "slop",
    source: "https://hackerone.com/reports/3125832",
    mapping: "The famous fabricated HTTP/3 'stream dependency cycle' exploit. curl implements HTTP/3 in lib/vquic/, not a lib/http3.c; the referenced location does not exist.",
    report: mk("slop_h1_3125832_http3", { title: "HTTP/3 Stream Dependency Cycle Exploit", claimedVersion: "8.13.0", body: "An HTTP/3 stream dependency cycle in lib/http3.c causes exploitable memory corruption." }),
  },
  {
    id: "slop_h1_2298307_websocket",
    kind: "slop",
    source: "https://hackerone.com/reports/2298307",
    mapping: "Stenberg could not find the claimed overflow. curl's WebSocket code is lib/ws.c, not a lib/websockets.c; the referenced location does not exist.",
    report: mk("slop_h1_2298307_websocket", { title: "Buffer Overflow Vulnerability in WebSocket Handling", claimedVersion: "8.5.0", body: "A buffer overflow in WebSocket frame handling in lib/websockets.c allows remote code execution." }),
  },
  {
    id: "slop_h1_2912277_vague",
    kind: "slop",
    source: "https://hackerone.com/reports/2912277",
    mapping: "Vague, cites no specific code; nothing to check deterministically.",
    report: mk("slop_h1_2912277_vague", { title: "Hackers Attack Curl Vulnerability Accessing Sensitive Information", claimedVersion: "8.10.0", body: "Attackers can access sensitive information through a curl vulnerability." }),
  },

  // ---- real curl CVEs (control set): all reference real code; none must be flagged SLOP ----
  {
    id: "cve_2023_38545_socks5",
    kind: "cve",
    source: "https://curl.se/docs/CVE-2023-38545.html",
    mapping: "SOCKS5 heap buffer overflow; the affected code is lib/socks.c (fixed in 8.4.0).",
    report: mk("cve_2023_38545_socks5", { title: "SOCKS5 heap buffer overflow", claimedVersion: "8.3.0", claimedSeverity: "high", body: "A slow SOCKS5 handshake can overflow the download buffer; the bug is in the SOCKS5 handling in lib/socks.c." }),
  },
  {
    id: "cve_2023_38546_cookie",
    kind: "cve",
    source: "https://curl.se/docs/CVE-2023-38546.html",
    mapping: "Cookie injection with none file; the affected code is lib/cookie.c (fixed in 8.4.0).",
    report: mk("cve_2023_38546_cookie", { title: "cookie injection with none file", claimedVersion: "8.3.0", claimedSeverity: "low", body: "Under specific conditions libcurl can be told to load cookies from a file named 'none'; the cookie handling is in lib/cookie.c." }),
  },
  {
    id: "cve_2024_2398_http2",
    kind: "cve",
    source: "https://curl.se/docs/CVE-2024-2398.html",
    mapping: "HTTP/2 push headers memory-leak; the affected code is lib/http2.c (fixed in 8.7.0).",
    report: mk("cve_2024_2398_http2", { title: "HTTP/2 push headers memory-leak", claimedVersion: "8.6.0", claimedSeverity: "medium", body: "When a server sends HTTP/2 PUSH_PROMISE headers libcurl can leak memory; the HTTP/2 handling is in lib/http2.c." }),
  },
  {
    id: "cve_2023_27535_ftp",
    kind: "cve",
    source: "https://curl.se/docs/CVE-2023-27535.html",
    mapping: "FTP too-eager connection reuse; the affected code (incl. ftp_state_user_resp) is lib/ftp.c.",
    report: mk("cve_2023_27535_ftp", { title: "FTP too eager connection reuse", claimedVersion: "8.0.0", claimedSeverity: "medium", body: "libcurl could reuse an FTP connection for a different user; the FTP state machine, including ftp_state_user_resp() in lib/ftp.c, does not compare all credentials." }),
  },
  {
    id: "cve_2022_27774_redirect",
    kind: "cve",
    source: "https://curl.se/docs/CVE-2022-27774.html",
    mapping: "Credential leak / cookie leak on redirect; the affected code is lib/transfer.c.",
    report: mk("cve_2022_27774_redirect", { title: "credential leak on redirect", claimedVersion: "7.82.0", claimedSeverity: "medium", body: "libcurl could leak credentials or cookies when following a redirect to a different protocol or port; the redirect handling is in lib/transfer.c." }),
  },
];
