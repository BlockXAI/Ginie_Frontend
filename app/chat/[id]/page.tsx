"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Archive, Download, ChevronDown, ChevronRight, ExternalLink, FileCode, FileJson, FileText, Folder, Globe, ShieldCheck } from "lucide-react";
import MarkdownViewer from "@/components/ui/MarkdownViewer";
import { LogViewer } from "@/components/LogViewer";
import {
  ChatIdHeader,
  ChatInput,
  FileViewer,
} from "@/components/chat";
import { api } from "@/lib/api";
import type { ArtifactSource, ArtifactAbi, ArtifactScript } from "@/lib/api";
import { consolidateMessages, getAllToolCalls } from "@/lib/chat-utils";
import type { Message, ActiveToolCall } from "@/lib/chat-types";
import { useAuth } from "@/components/auth/AuthProvider";

export default function ChatIdPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatId = params.id as string;
  const BACKEND_DISABLED = true;
  const mode = (searchParams?.get('mode') || '').toLowerCase();
  const isDappMode = mode === 'dapp';
  const isFrontendMode = mode === 'frontend';
  const isBuilderMode = mode === 'builder' || isDappMode || isFrontendMode;

  const [wsConnected, setWsConnected] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const { user: userData } = useAuth();
  const [currentTool, setCurrentTool] = useState<ActiveToolCall | null>(null);
  const [isCheckingUrl, setIsCheckingUrl] = useState(false);
  const [showAllToolsDropdown, setShowAllToolsDropdown] = useState(false);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [sources, setSources] = useState<ArtifactSource[]>([]);
  const [abis, setAbis] = useState<ArtifactAbi[]>([]);
  const [scripts, setScripts] = useState<ArtifactScript[]>([]);
  const [displayFiles, setDisplayFiles] = useState<{
    label: string;
    kind: "source" | "abi" | "script" | "report";
    path: string;
  }[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [preview, setPreview] = useState<string>("");
  const [treeOpen, setTreeOpen] = useState(true);
  const [colW, setColW] = useState<[number, number, number]>([40, 20, 40]);
  const [draggingIndex, setDraggingIndex] = useState<0 | 1 | null>(null);
  const [auditMd, setAuditMd] = useState<string>("");
  const [complianceMd, setComplianceMd] = useState<string>("");
  // DApp-specific state
  const [contractAddress, setContractAddress] = useState<string | null>(null);
  const [contractNetwork, setContractNetwork] = useState<string>("avalanche-fuji");
  const [contractExplorerUrl, setContractExplorerUrl] = useState<string | null>(null);
  const [contractVerified, setContractVerified] = useState(false);
  const [contractName, setContractName] = useState<string | null>(null);
  const [vercelUrl, setVercelUrl] = useState<string | null>(null);
  const [localFileContent, setLocalFileContent] = useState<Record<string, string>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const urlCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const pageAbortRef = useRef<AbortController | null>(null);
  const lastIndexRef = useRef<number>(0);
  const seenIdxRef = useRef<Set<number>>(new Set());
  const lastMagicRef = useRef<string>("");
  const helloShownRef = useRef<boolean>(false);
  const seenMagicRef = useRef<Set<string>>(new Set());
  const magicQueueRef = useRef<string[]>([]);
  const seenMsgRef = useRef<Set<string>>(new Set());
  const msgQueueRef = useRef<string[]>([]);
  const artifactsLoadedRef = useRef<boolean>(false);
  const API_BASE = typeof window !== "undefined" ? "/api/proxy" : ((process.env.NEXT_PUBLIC_API_BASE_URL as string) || "https://evi-user-apis-production.up.railway.app");
  const [currentStage, setCurrentStage] = useState<string>("");

  // restore pane widths
  useEffect(() => {
    try {
      const saved = typeof window !== "undefined" ? localStorage.getItem("chat_layout_cols") : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 3) setColW([+parsed[0], +parsed[1], +parsed[2]]);
      }
    } catch {}
  }, []);

  // persist pane widths
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem("chat_layout_cols", JSON.stringify(colW)); } catch {}
  }, [colW]);

  // Auth is handled by middleware + AuthProvider; no client-side auth gate here

  // Abort in-flight requests quickly on navigation/reload (reduces noisy WebKit console errors)
  useEffect(() => {
    const onPageHide = () => {
      try { streamAbortRef.current?.abort(); } catch {}
      try { pageAbortRef.current?.abort(); } catch {}
    };
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onPageHide);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("beforeunload", onPageHide);
      }
    };
  }, []);

  // Function to fetch project files
  const fetchProjectFiles = async () => {
    if (!isBuilderMode) {
      setProjectFiles([]);
      return;
    }
    try {
      const res = await api.builderListFiles(chatId);
      const files = (res as any)?.files;
      setProjectFiles(Array.isArray(files) ? files : []);
    } catch {
      setProjectFiles([]);
    }
  };

  // Function to check if URL is ready
  const checkUrlReady = async (url: string): Promise<boolean> => {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        mode: "no-cors", // This will prevent CORS errors
      });
      // With no-cors, we can't read the status, but if it doesn't throw, it's accessible
      return true;
    } catch {
      return false;
    }
  };

  // Load DApp contract info and project detail after build
  async function loadDappInfo(pid: string) {
    const pageSignal = pageAbortRef.current?.signal;
    try {
      // Load contracts info
      const contractRes = await api.builderGetContracts(pid, { signal: pageSignal });
      const contracts = (contractRes as any)?.contracts || [];
      const cached = (contractRes as any)?.cached_contract;
      if (contracts.length > 0) {
        const c = contracts[0];
        if (c.address) { setContractAddress(c.address); setContractName(c.name || null); }
        if (c.explorer_url) setContractExplorerUrl(c.explorer_url);
        if (c.verified) setContractVerified(true);
        if (c.network) setContractNetwork(c.network);
        // Inject contract files (source & ABI) into projectFiles so they appear in the file tree
        const contractFiles: string[] = [];
        const newLocal: Record<string, string> = {};
        const cName = c.name || 'Contract';
        if (c.source_code) {
          const solPath = `contracts/${cName}.sol`;
          contractFiles.push(solPath);
          newLocal[solPath] = c.source_code;
        }
        if (c.abi) {
          const abiPath = `contracts/${cName}.abi.json`;
          contractFiles.push(abiPath);
          newLocal[abiPath] = JSON.stringify(c.abi, null, 2);
        }
        if (contractFiles.length > 0) {
          setLocalFileContent(prev => ({ ...prev, ...newLocal }));
          setProjectFiles(prev => {
            const existing = new Set(prev);
            const merged = [...prev];
            for (const cf of contractFiles) { if (!existing.has(cf)) merged.push(cf); }
            return merged;
          });
        }
      } else if (cached?.address) {
        setContractAddress(cached.address);
        if (cached.name) setContractName(cached.name);
        if (cached.explorer_url) setContractExplorerUrl(cached.explorer_url);
        if (cached.verified) setContractVerified(true);
      }
    } catch {}
    try {
      // Load project detail for Vercel URL and other metadata
      const detailRes = await api.builderGetProject(pid, { includeMessages: false }, { signal: pageSignal });
      const proj = (detailRes as any)?.project;
      if (proj?.vercel_url) {
        setVercelUrl(proj.vercel_url);
        setAppUrl(proj.vercel_url);
        // If project has a deployed URL, mark as completed
        setCurrentStage("completed");
        setProgress(100);
        setState("completed");
        setIsBuilding(false);
      }
      if (proj?.contract_address && !contractAddress) setContractAddress(proj.contract_address);
      if (proj?.contract_explorer_url) setContractExplorerUrl(proj.contract_explorer_url);
      if (proj?.contract_verified) setContractVerified(true);
      if (proj?.contract_name) setContractName(proj.contract_name);
      if (proj?.contract_network) setContractNetwork(proj.contract_network);
    } catch {}
  }

  async function streamBuilderEvents(pid: string, didRefresh = false) {
    try {
      streamAbortRef.current?.abort();
      const ac = new AbortController();
      streamAbortRef.current = ac;
      const pageSignal = pageAbortRef.current?.signal;
      if (pageSignal?.aborted) return;

      // Hydrate current build status first so refresh doesn't reset progress
      // and so we can resume even if the SSE stream reconnects late.
      try {
        const st = await api.builderGetStatus(pid, { signal: pageSignal });
        const s = (st as any)?.status;
        const isBuilding = !!(s?.task_running || s?.is_building || s?.build_status === "building");
        const isCompleted = !!(s?.build_status === "completed");
        const isFailed = !!(s?.build_status === "failed");
        if (isFailed) {
          setState("failed");
        } else if (isCompleted) {
          setState("completed");
          setCurrentStage("completed");
          setProgress(100);
        } else if (isBuilding) {
          setState("running");
        }
      } catch {}

      // Only set an initial stage if we truly have nothing yet (first render)
      if (isDappMode || isFrontendMode) {
        setState((prev) => prev || "running");
        setCurrentStage((prev) => prev || (isDappMode ? "generate" : "building"));
        setProgress((prev) => (prev == null ? 5 : prev));
      }

      const url = `${API_BASE}/u/proxy/builder/projects/${encodeURIComponent(pid)}/events/stream`;
      const res = await fetch(url, {
        credentials: 'include',
        signal: ac.signal,
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
      });
      if (res.status === 401 && !didRefresh) {
        try {
          await api.refresh({ signal: pageSignal });
          return streamBuilderEvents(pid, true);
        } catch {}
      }
      if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);

      // Don't eagerly fetch files — wait for file events to avoid 404
      let filesInitialized = false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let eventType = 'message';
      const append = (line: string) => setLogs((prev) => [...prev, line]);
      let lastFileRefresh = 0;
      let fileRefreshTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleFileRefresh = () => {
        const now = Date.now();
        if (now - lastFileRefresh < 5000) {
          // Debounce: schedule one trailing fetch after quiet period
          if (!fileRefreshTimer) {
            fileRefreshTimer = setTimeout(() => {
              fileRefreshTimer = null;
              lastFileRefresh = Date.now();
              filesInitialized = true;
              void fetchProjectFiles();
            }, 2000);
          }
          return;
        }
        lastFileRefresh = now;
        filesInitialized = true;
        setTimeout(() => { void fetchProjectFiles(); }, 300);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = chunk.split('\n');
          let dataStr = '';
          eventType = 'message';
          for (const l of lines) {
            if (l.startsWith('event:')) eventType = l.slice(6).trim();
            else if (l.startsWith('data:')) dataStr += l.slice(5).trim() + '\n';
          }
          dataStr = dataStr.trimEnd();
          if (!dataStr) continue;

          if (eventType === 'message') {
            let j: any = null;
            try { j = JSON.parse(dataStr); } catch { j = null; }
            if (j) {
              const ev = String(j.e || j.type || '').trim();
              const msg = j.message != null ? String(j.message) : '';

              // --- Skip noisy events from logs ---
              if (ev === 'heartbeat') continue;
              if (ev === 'history') {
                // Silent — just extract any existing app_url/vercel_url
                if (j.app_url) setAppUrl(j.app_url);
                if (j.vercel_url) { setVercelUrl(j.vercel_url); setAppUrl(j.vercel_url); }
                continue;
              }

              // --- Builder lifecycle events ---
              if (ev === 'builder_started' || ev === 'workflow_started' || ev === 'started') {
                setIsBuilding(true);
                if (isDappMode) { setCurrentStage("generate"); setProgress(10); }
                else if (isFrontendMode) { setCurrentStage("building"); setProgress(10); }
              }
              if (ev === 'workflow_completed' || ev === 'completed') {
                setIsBuilding(false);
                if (isDappMode || isFrontendMode) { setCurrentStage("completed"); setProgress(100); setState("completed"); }
              }
              if (ev === 'file_created' || ev === 'snapshot_saved' || ev === 'files_updated') scheduleFileRefresh();

              // --- DApp-specific: contract pipeline events ---
              if (isDappMode) {
                // Pipeline progress (detailed stages from polling)
                if (ev === 'pipeline_progress') {
                  const pStage = j.stage || '';
                  const pProgress = j.progress || 0;
                  // Map pipeline stages to UI stages
                  if (pStage === 'generating' || pStage === 'pending') {
                    setCurrentStage("generate"); setProgress(Math.max(10, Math.min(pProgress, 25)));
                  } else if (pStage === 'compiling' || pStage === 'compiled') {
                    setCurrentStage("compile"); setProgress(Math.max(25, Math.min(pProgress, 45)));
                  } else if (pStage === 'deploying') {
                    setCurrentStage("deploy"); setProgress(Math.max(45, Math.min(pProgress, 60)));
                  } else if (pStage === 'deployed') {
                    setCurrentStage("deploy"); setProgress(65);
                  } else if (pStage === 'verifying' || pStage === 'verified') {
                    setCurrentStage("verify"); setProgress(70);
                  }
                  // Extract contract info from pipeline progress
                  if (j.contract_address) setContractAddress(j.contract_address);
                  if (j.tx_hash && j.tx_hash.length > 0) {
                    append(`[deploy] Tx: ${j.tx_hash}`);
                  }
                  // Show the stage label
                  if (msg) append(`[pipeline] ${msg}`);
                  continue;
                }

                // High-level orchestrator events
                if (ev === 'contract_generating') {
                  setCurrentStage("generate"); setProgress(10);
                }
                if (ev === 'contract_deploying') {
                  setCurrentStage("compile"); setProgress(30);
                }
                if (ev === 'contract_deployed') {
                  setCurrentStage("verify"); setProgress(70);
                  const addr = j.contract_address || j.address;
                  if (addr) {
                    setContractAddress(addr);
                    if (j.contract_name) setContractName(j.contract_name);
                    const net = j.network || contractNetwork;
                    setContractNetwork(net);
                    if (j.explorer_url) {
                      setContractExplorerUrl(j.explorer_url);
                    } else {
                      const explorerUrls: Record<string, string> = {
                        "avalanche-fuji": "https://testnet.snowtrace.io",
                        "avalanche-mainnet": "https://snowtrace.io",
                        "ethereum-sepolia": "https://sepolia.etherscan.io",
                        "ethereum-mainnet": "https://etherscan.io",
                      };
                      const explorerBase = explorerUrls[net] || explorerUrls["avalanche-fuji"];
                      setContractExplorerUrl(`${explorerBase}/address/${addr}`);
                    }
                  }
                  if (j.tx_hash) append(`[deploy] Tx: ${j.tx_hash}`);
                }
                if (ev === 'contract_verifying') {
                  setCurrentStage("verify"); setProgress(72);
                }
                if (ev === 'contract_verified' || ev === 'verified' || ev === 'verification_complete') {
                  setContractVerified(true);
                  setProgress(74);
                }
                if (ev === 'contract_verify_skipped') {
                  // Non-fatal: verification didn't complete yet
                  setProgress(74);
                }
                if (ev === 'contract_failed') {
                  setState("failed");
                }

                // Frontend generation events
                if (ev === 'frontend_generating') {
                  setCurrentStage("deploy"); setProgress(75);
                  append("━━━ Frontend Generation ━━━");
                }
                if (ev === 'frontend_building') {
                  setCurrentStage("deploy"); setProgress(78);
                }
                // Agent events during frontend build
                if (ev === 'prompt_enhanced' || ev === 'plan_created' || ev === 'plan_generated') {
                  setProgress(80);
                }
                if (ev === 'building' || ev === 'code_generated') {
                  setProgress(83);
                }
                if (ev === 'validating' || ev === 'code_validated') {
                  setProgress(85);
                }
                if (ev === 'build_success' || ev === 'build_complete') {
                  setProgress(88);
                  scheduleFileRefresh();
                }
                if (ev === 'deploying_vercel' || ev === 'vercel_deploying') {
                  setProgress(90);
                }
                if (ev === 'deployment_complete' || ev === 'vercel_deployed') {
                  setProgress(95);
                  const vUrl = j.vercel_url || j.url || j.deploy_url;
                  if (vUrl) { setVercelUrl(vUrl); setAppUrl(vUrl); }
                  scheduleFileRefresh();
                }
                if (ev === 'failed') {
                  setState("failed");
                }
              }

              // --- Frontend-only: build workflow events ---
              if (isFrontendMode) {
                // LangGraph workflow events
                if (ev === 'prompt_enhancer_started' || ev === 'prompt_enhanced') {
                  setCurrentStage("planning"); setProgress(15);
                }
                if (ev === 'planner_started' || ev === 'planner_complete' || ev === 'plan_created') {
                  setCurrentStage("planning"); setProgress(25);
                }
                if (ev === 'builder_started' || ev === 'building' || ev === 'code_generated') {
                  setCurrentStage("building"); setProgress(45);
                }
                if (ev === 'code_validator_started' || ev === 'validation_success' || ev === 'code_validated') {
                  setCurrentStage("validating"); setProgress(60);
                }
                if (ev === 'app_check_started' || ev === 'build_success' || ev === 'build_complete') {
                  setCurrentStage("checking"); setProgress(75);
                  scheduleFileRefresh();
                }
                if (ev === 'deployment_started' || ev === 'deploying_vercel' || ev === 'vercel_deploying') {
                  setCurrentStage("deploying"); setProgress(85);
                }
                if (ev === 'deployment_success' || ev === 'deployment_complete' || ev === 'vercel_deployed') {
                  setCurrentStage("completed"); setProgress(100);
                  const vUrl = j.vercel_url || j.url || j.deploy_url;
                  if (vUrl) { setVercelUrl(vUrl); setAppUrl(vUrl); }
                  scheduleFileRefresh();
                  setState("completed");
                }
                if (ev === 'failed' || ev === 'error') {
                  setState("failed");
                }
              }

              // Preview URLs (works for both builder and dapp modes)
              if (typeof j.preview_url === 'string' && j.preview_url) setAppUrl(j.preview_url);
              if (typeof j.vercel_url === 'string' && j.vercel_url) { setVercelUrl(j.vercel_url); setAppUrl(j.vercel_url); }
              if (typeof j.url === 'string' && j.url && ev !== 'pipeline_progress') setAppUrl(j.url);
              if (typeof j.app_url === 'string' && j.app_url) setAppUrl(j.app_url);

              // Log the event (for non-pipeline-progress which handled above)
              if (ev || msg) {
                append(`[${ev || 'event'}] ${msg}`);
              } else {
                append(dataStr);
              }
            } else {
              append(dataStr);
            }
          } else if (eventType === 'upstream_close') {
            // Upstream WS closed; this can happen on actual completion OR transient network issues.
            // Decide based on backend build status instead of assuming completion.
            if (isDappMode || isFrontendMode) {
              try {
                const st = await api.builderGetStatus(pid, { signal: pageSignal });
                const s = (st as any)?.status;
                const isBuilding = !!(s?.task_running || s?.is_building || s?.build_status === "building");
                const isCompleted = !!(s?.build_status === "completed");
                const isFailed = !!(s?.build_status === "failed");
                await loadDappInfo(pid);
                if (!filesInitialized) await fetchProjectFiles();

                if (isFailed) {
                  setState("failed");
                } else if (isCompleted) {
                  setCurrentStage("completed");
                  setProgress(100);
                  setState("completed");
                } else if (isBuilding) {
                  // Keep running; reconnect below when the stream ends.
                  setState("running");
                }
              } catch {}
            }
          } else if (eventType === 'error') {
            append(`[error] ${dataStr}`);
            setError(dataStr);
            if (isDappMode || isFrontendMode) setState("failed");
          }
        }
      }

      // Stream ended — do NOT assume completion. Hydrate from status and reconnect if still building.
      if (isDappMode || isFrontendMode) {
        let shouldReconnect = false;
        try {
          const st = await api.builderGetStatus(pid, { signal: pageSignal });
          const s = (st as any)?.status;
          const isBuilding = !!(s?.task_running || s?.is_building || s?.build_status === "building");
          const isCompleted = !!(s?.build_status === "completed");
          const isFailed = !!(s?.build_status === "failed");
          await loadDappInfo(pid);
          if (!filesInitialized) await fetchProjectFiles();
          if (isFailed) setState("failed");
          else if (isCompleted) {
            setCurrentStage("completed");
            setProgress(100);
            setState("completed");
          } else if (isBuilding) {
            setState("running");
            shouldReconnect = true;
          }
        } catch {
          // If status can't be fetched (network blip), attempt a reconnect.
          shouldReconnect = true;
        }

        if (shouldReconnect && !(ac.signal.aborted || pageSignal?.aborted)) {
          setTimeout(() => {
            if (!(ac.signal.aborted || pageAbortRef.current?.signal?.aborted)) {
              void streamBuilderEvents(pid, didRefresh);
            }
          }, 1000);
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      const msg = String(e?.message || 'Stream error');
      // Treat transient network stream drops as recoverable.
      const recoverable = /incomplete_chunked_encoding/i.test(msg) || /network/i.test(msg) || /fetch/i.test(msg);
      if (!recoverable) setError(msg);
      if (isDappMode && !recoverable) setState("failed");
      if (recoverable && !(pageAbortRef.current?.signal?.aborted)) {
        setTimeout(() => void streamBuilderEvents(pid, didRefresh), 1200);
      }
    }
  }

  // Poll URL until it's ready
  const pollUrlUntilReady = async (url: string) => {
    setIsCheckingUrl(true);
    let attempts = 0;
    const maxAttempts = 20;

    const checkInterval = setInterval(async () => {
      attempts++;
      const isReady = await checkUrlReady(url);

      if (isReady || attempts >= maxAttempts) {
        clearInterval(checkInterval);
        setIsCheckingUrl(false);
        setAppUrl(url);
      }
    }, 1000);

    urlCheckIntervalRef.current = checkInterval;
  };

  // Cleanup interval on unmount
  useEffect(() => {
    if (BACKEND_DISABLED) return;
    return () => {
      if (urlCheckIntervalRef.current) {
        clearInterval(urlCheckIntervalRef.current);
      }
    };
  }, []);

  // For builder/dapp mode, file fetching is driven by SSE events (scheduleFileRefresh).
  // For normal mode with appUrl, do a single delayed fetch — no polling needed.
  useEffect(() => {
    if (BACKEND_DISABLED) return;
    if (typeof window === "undefined") return;
    if (isBuilderMode) return; // SSE events handle file refreshes in builder/dapp mode

    if (appUrl && chatId) {
      const timeout = setTimeout(() => { fetchProjectFiles(); }, 1500);
      return () => clearTimeout(timeout);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUrl, chatId]);

  // Start streaming logs for this job and poll status
  useEffect(() => {
    if (!chatId) return;
    pageAbortRef.current?.abort();
    pageAbortRef.current = new AbortController();
    setLogs([]);
    setProgress(null);
    setState(null);
    lastIndexRef.current = 0;
    seenIdxRef.current.clear();
    artifactsLoadedRef.current = false; // Reset on new job
    seenMagicRef.current.clear();
    magicQueueRef.current = [];
    seenMsgRef.current.clear();
    msgQueueRef.current = [];
    lastMagicRef.current = "";
    helloShownRef.current = false;
    setCurrentStage("");
    (async () => {
      if (isBuilderMode) {
        await streamBuilderEvents(chatId);
      } else {
        await streamLogs(chatId);
      }
    })();
    return () => {
      pageAbortRef.current?.abort();
      streamAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isBuilderMode]);

  // On page load for builder/dapp mode, immediately load existing project state
  // This ensures refresh works correctly even if SSE doesn't replay historical events
  useEffect(() => {
    if (BACKEND_DISABLED) return;
    if (!chatId || !isBuilderMode) return;

    // Small delay to let SSE connect first, then load existing state
    const initTimer = setTimeout(async () => {
      try {
        // Load project info (Vercel URL, contract details)
        await loadDappInfo(chatId);
        // Load files
        await fetchProjectFiles();
      } catch (e) {
        console.warn("Failed to load existing project state:", e);
      }
    }, 800);

    return () => clearTimeout(initTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isBuilderMode]);

  // Listen for header-level file open requests
  useEffect(() => {
    const onOpenFiles = () => setShowPreview(false);
    window.addEventListener("open-files-panel", onOpenFiles as EventListener);
    return () => window.removeEventListener("open-files-panel", onOpenFiles as EventListener);
  }, []);

  // Handler when user attaches files from ChatInput
  const handleAttachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: { label: string; kind: any; path: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const text = await f.text().catch(() => "");
      const entry = { label: f.name, kind: "source", path: f.name };
      added.push(entry);
      // add preview for the last file
      if (i === files.length - 1) {
        setPreview(text || "");
        setSelectedPath(f.name);
      }
    }
    setDisplayFiles((prev) => {
      // avoid duplicates by path
      const existing = new Set(prev.map((p) => p.path));
      const merged = [...prev];
      added.forEach((a) => {
        if (!existing.has(a.path)) merged.push(a as any);
      });
      return merged;
    });
    // Ensure files panel is visible
    setShowPreview(false);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle drag resize for gutters between panes
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingIndex === null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const r = ((e.clientX - rect.left) / rect.width) * 100; // mouse in %
      const min0 = 15, min1 = 12, min2 = 20;
      if (draggingIndex === 0) {
        const maxLeft = colW[0] + colW[1] - min1;
        let new0 = Math.max(min0, Math.min(r, maxLeft));
        let new1 = colW[0] + colW[1] - new0;
        setColW([new0, new1, colW[2]]);
      } else if (draggingIndex === 1) {
        const leftFixed = colW[0];
        const maxLeftPlusMid = 100 - min2;
        let leftPlusMid = Math.max(leftFixed + min1, Math.min(r, maxLeftPlusMid));
        let new1 = leftPlusMid - leftFixed;
        let new2 = 100 - leftPlusMid;
        setColW([leftFixed, new1, new2]);
      }
    };
    const onUp = () => setDraggingIndex(null);
    if (draggingIndex !== null) {
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
      document.body.style.cursor = "col-resize";
      return () => {
        document.removeEventListener("mousemove", onMove);
        document.body.style.cursor = "";
      };
    }
  }, [draggingIndex, colW]);

  // WebSocket disabled; no-op
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [chatId]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBuilderMode || isDappMode) {
      setError("This view is read-only for now. Start a new project from the chat page.");
      return;
    }
    if (!input.trim()) return;
    try {
      setIsBuilding(true);
      const started = await api.startPipeline({
        prompt: input.trim(),
        network: "avalanche-fuji",
        maxIters: 3,
        filename: "Generated.sol",
        strictArgs: true,
        constructorArgs: [],
        jobKind: "pipeline",
      });
      const jid = (started as any)?.job?.id;
      if (!jid) throw new Error("Failed to start job");
      setInput("");
      router.push(`/chat/${encodeURIComponent(jid)}`);
    } catch (err: any) {
      setError(err?.message || "Failed to start pipeline");
    } finally {
      setIsBuilding(false);
    }
  };

  async function streamLogs(jid: string, didRefresh = false) {
    try {
      streamAbortRef.current?.abort();
      const ac = new AbortController();
      streamAbortRef.current = ac;
      const pageSignal = pageAbortRef.current?.signal;
      if (pageSignal?.aborted) return;
      const url = `${API_BASE}/u/proxy/job/${encodeURIComponent(jid)}/logs/stream?afterIndex=${lastIndexRef.current}&includeMagical=1`;
      try { console.log(JSON.stringify({ level: "debug", msg: "sse.stream.start", url })); } catch {}
      const res = await fetch(url, {
        credentials: "include",
        signal: ac.signal,
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
      });
      if (res.status === 401 && !didRefresh) {
        try { console.log(JSON.stringify({ level: "warn", msg: "sse.stream.unauthorized", url })); } catch {}
        try {
          await api.refresh({ signal: pageSignal });
          return streamLogs(jid, true);
        } catch {}
      }
      if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let eventType = "message";
      const append = (line: string) => setLogs((prev) => [...prev, line]);
      const stageFromMsg = (msg: string): string | null => {
        const m = msg.match(/Stage:\s*([a-zA-Z_]+)(?:\s*->\s*([^\n]+))?/);
        if (m) return m[1].toLowerCase();
        return null;
      };
      const bumpProgressForStage = (stage: string) => {
        const map: Record<string, number> = {
          generate: 10,
          write: 20,
          compile: 60,
          deploy_script: 75,
          deploy: 90,
          verify: 95,
          completed: 100,
        };
        const p = map[stage];
        if (typeof p === "number") setProgress((prev) => (prev == null ? p : Math.max(prev, p)));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = chunk.split("\n");
          let dataStr = "";
          eventType = "message";
          for (const l of lines) {
            if (l.startsWith("event:")) eventType = l.slice(6).trim();
            else if (l.startsWith("data:")) dataStr += l.slice(5).trim();
          }
          if (!dataStr) continue;
          try {
            const json = JSON.parse(dataStr);
            if (eventType === "log" && json?.msg) {
              const idx = json?.i;
              if (typeof idx === "number") {
                if (seenIdxRef.current.has(idx)) continue;
                seenIdxRef.current.add(idx);
                lastIndexRef.current = Math.max(lastIndexRef.current, idx);
              }
              const msg: string = String(json.msg);
              const st = stageFromMsg(msg);
              if (st) {
                setCurrentStage(st);
                bumpProgressForStage(st);
                const stageLine = `─── ▶ Stage: ${st}${json.level ? ` [${json.level}]` : ""}`;
                if (!seenMsgRef.current.has(stageLine)) {
                  append(stageLine);
                  seenMsgRef.current.add(stageLine);
                  msgQueueRef.current.push(stageLine);
                }
              }
              const final = `[${json.level || "info"}] ${msg}`;
              if (!seenMsgRef.current.has(final)) {
                append(final);
                seenMsgRef.current.add(final);
                msgQueueRef.current.push(final);
              }
            } else if (eventType === "magic" && json?.msg) {
              const m = String(json.msg);
              if (m === lastMagicRef.current) continue;
              lastMagicRef.current = m;
              if (seenMagicRef.current.has(m)) continue;
              seenMagicRef.current.add(m);
              magicQueueRef.current.push(m);
              const st = stageFromMsg(m);
              if (st) {
                setCurrentStage(st);
                bumpProgressForStage(st);
                const stageLine = `─── ▶ Stage: ${st}`;
                if (!seenMsgRef.current.has(stageLine)) {
                  append(stageLine);
                  seenMsgRef.current.add(stageLine);
                  msgQueueRef.current.push(stageLine);
                }
              }
              if (!seenMsgRef.current.has(m)) {
                append(m);
                seenMsgRef.current.add(m);
                msgQueueRef.current.push(m);
              }
            } else if (eventType === "hello" && json?.id) {
              if (!helloShownRef.current) {
                append(`Connected to job ${json.id}`);
                helloShownRef.current = true;
              }
            } else if (eventType === "heartbeat") {
              // no-op
            } else if (eventType === "verification.started") {
              const net = json?.network || "unknown";
              const addr = json?.address || "";
              setCurrentStage("verify");
              bumpProgressForStage("verify");
              const line = `🔍 Verifying contract${addr ? ` (${addr.slice(0, 10)}...)` : ""} on ${net}...`;
              if (!seenMsgRef.current.has(line)) {
                append(line);
                seenMsgRef.current.add(line);
                msgQueueRef.current.push(line);
              }
            } else if (eventType === "verification.complete") {
              const ok = json?.ok;
              const verified = json?.verified;
              const errMsg = json?.error;
              if (ok || verified) {
                const line = `✅ Contract verified successfully!`;
                if (!seenMsgRef.current.has(line)) {
                  append(line);
                  seenMsgRef.current.add(line);
                  msgQueueRef.current.push(line);
                }
                // Mark completed after verification (verification can arrive after the job stream "end")
                setState("completed");
                setCurrentStage("completed");
                bumpProgressForStage("completed");
                setProgress(100);

                // Update job cache with verified status (backend requires state)
                try {
                  await api.updateJobCache({ jobId: jid, state: "completed", verified: true });
                } catch {}

                // Ensure artifacts are loaded even if the job stream ended before verification finished
                try {
                  if (!(ac.signal.aborted || pageSignal?.aborted)) {
                    await loadArtifacts(jid, { signal: pageSignal });
                  }
                } catch {}
              } else {
                const line = `⚠️ Verification: ${errMsg || "failed (will retry on next deploy)"}`;
                if (!seenMsgRef.current.has(line)) {
                  append(line);
                  seenMsgRef.current.add(line);
                  msgQueueRef.current.push(line);
                }
              }
            } else if (eventType === "end") {
              append("[done] Job completed");
              setState("completed");
              setCurrentStage("completed");
              bumpProgressForStage("completed");
              let contractName: string | null = null;
              let deployedAddress: string | null = null;
              try {
                if (ac.signal.aborted || pageSignal?.aborted) return;
                const details = await api.job(jid, { signal: pageSignal });
                const addr = (details as any)?.result?.address;
                deployedAddress = addr || null;
                // Extract contract name from job details
                contractName = (details as any)?.result?.contract ||
                               (details as any)?.result?.fqName?.split(":").pop() ||
                               null;
                if (addr) append(`Deployed address: ${addr}`);
              } catch {}
              // Try to extract contract name from logs if not found in details
              if (!contractName) {
                const allLogs = msgQueueRef.current.join("\n");
                // Look for DEPLOY_RESULT JSON
                const deployMatch = allLogs.match(/DEPLOY_RESULT\s*({[^}]+})/);
                if (deployMatch) {
                  try {
                    const deployData = JSON.parse(deployMatch[1]);
                    contractName = deployData.contract || deployData.fqName?.split(":").pop();
                  } catch {}
                }
                // Fallback: look for "Artifact chosen for deploy: ContractName"
                if (!contractName) {
                  const artifactMatch = allLogs.match(/Artifact chosen for deploy:\s*(\w+)/i);
                  if (artifactMatch) contractName = artifactMatch[1];
                }
              }
              // Auto-update job title with contract name
              if (contractName) {
                try {
                  await api.updateJobMeta(jid, { title: contractName });
                  console.log(`[Chat] Updated job title to: ${contractName}`);
                } catch (e) {
                  console.warn("[Chat] Failed to update job title:", e);
                }
              }
              // Update job cache with completion status
              try {
                const allLogs = msgQueueRef.current.join("\n");
                let network = "avalanche-fuji";
                let fqName: string | undefined;
                const deployMatch = allLogs.match(/DEPLOY_RESULT\s*({[^}]+})/);
                if (deployMatch) {
                  try {
                    const deployData = JSON.parse(deployMatch[1]);
                    network = deployData.network || network;
                    fqName = deployData.fqName;
                  } catch {}
                }
                const explorerUrls: Record<string, string> = {
                  "avalanche-fuji": "https://testnet.snowtrace.io",
                  "avalanche-mainnet": "https://snowtrace.io",
                  "ethereum-sepolia": "https://sepolia.etherscan.io",
                  "ethereum-mainnet": "https://etherscan.io",
                };
                const explorerUrl = deployedAddress
                  ? `${explorerUrls[network] || explorerUrls["avalanche-fuji"]}/address/${deployedAddress}`
                  : undefined;
                await api.updateJobCache({
                  jobId: jid,
                  state: "completed",
                  progress: 100,
                  address: deployedAddress || undefined,
                  fq_name: fqName,
                  explorer_url: explorerUrl,
                  completed_at: new Date().toISOString(),
                });
                console.log(`[Chat] Updated job cache for ${jid}`);
              } catch (e) {
                console.warn("[Chat] Failed to update job cache:", e);
              }
              try {
                if (ac.signal.aborted || pageSignal?.aborted) return;
                await loadArtifacts(jid, { signal: pageSignal });
              } catch {}
            }
          } catch {
            append(dataStr);
          }
        }
      }
      // bound dedupe caches to last 500 lines
      while (msgQueueRef.current.length > 500) {
        const v = msgQueueRef.current.shift();
        if (v) seenMsgRef.current.delete(v);
      }
      while (magicQueueRef.current.length > 500) {
        const v = magicQueueRef.current.shift();
        if (v) seenMagicRef.current.delete(v);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message || "Stream error");
    }
  }

  // removed polling; status derived from SSE stream

  async function loadArtifacts(jid: string, extra?: { signal?: AbortSignal }) {
    const signal = extra?.signal;
    if (signal?.aborted) return;

    if (artifactsLoadedRef.current) return;
    artifactsLoadedRef.current = true;
    setArtifactsLoading(true);

    // STEP 1: Load sources, ABIs, scripts FIRST (priority artifacts)
    let srcs: ArtifactSource[] = [];
    let abisArr: ArtifactAbi[] = [];
    let scriptsArr: ArtifactScript[] = [];

    try {
      // Try combined endpoint first (faster if available)
      const combined = await api.artifacts(jid, { signal });
      srcs = (combined as any)?.sources || [];
      abisArr = (combined as any)?.abis || [];
      scriptsArr = (combined as any)?.scripts || [];
    } catch (e) {
      if (signal?.aborted) return;
      // Fallback to individual endpoints
      try {
        const [s1, a1, sc1] = await Promise.allSettled([
          api.artifactSources(jid, { signal }),
          api.artifactAbis(jid, { signal }),
          api.artifactScripts(jid, { signal }),
        ]);
        srcs = s1.status === "fulfilled" ? (s1.value as any).sources || [] : [];
        abisArr = a1.status === "fulfilled" ? (a1.value as any).abis || [] : [];
        scriptsArr = sc1.status === "fulfilled" ? (sc1.value as any).scripts || [] : [];
      } catch {}
    }

    // Update state with primary artifacts immediately
    setSources(srcs);
    setAbis(abisArr);
    setScripts(scriptsArr);

    // Build initial file list with primary artifacts
    const files: { label: string; kind: "source" | "abi" | "script" | "report"; path: string }[] = [];
    if (srcs[0]) files.push({ label: "solidity.sol", kind: "source", path: srcs[0].path });
    if (abisArr[0]) files.push({ label: "abi.json", kind: "abi", path: abisArr[0].path });
    if (scriptsArr[0]) files.push({ label: "Script.js", kind: "script", path: scriptsArr[0].path });

    // Show primary artifacts immediately
    setDisplayFiles([...files]);
    if (files[0]) {
      setSelectedPath(files[0].path);
      if (files[0].kind === "source") setPreview(srcs[0]?.content || "");
      else if (files[0].kind === "script") setPreview(scriptsArr[0]?.content || "");
      else if (files[0].kind === "abi") setPreview(JSON.stringify({ name: abisArr[0]?.name, abi: abisArr[0]?.abi }, null, 2));
    }

    // Mark primary loading complete
    setArtifactsLoading(false);

    // STEP 2: Load audit and compliance reports asynchronously (non-blocking)
    // These take longer to generate, so we load them in the background
    (async () => {
      if (signal?.aborted) return;
      try {
        const [a1, c1] = await Promise.allSettled([
          api.auditByJobMd(jid, { signal }),
          api.complianceByJobMd(jid, { signal }),
        ]);

        const newFiles = [...files];

        if (a1.status === "fulfilled" && a1.value) {
          setAuditMd(a1.value as string);
          newFiles.push({ label: "Audit.md", kind: "report", path: "audit.md" });
        }
        if (c1.status === "fulfilled" && c1.value) {
          setComplianceMd(c1.value as string);
          newFiles.push({ label: "Compliance.md", kind: "report", path: "compliance.md" });
        }

        // Update file list with reports if any were loaded
        if (newFiles.length > files.length) {
          setDisplayFiles(newFiles);
        }
      } catch {}
    })();
  }

  function onSelectDisplayFile(file: { label: string; kind: "source" | "abi" | "script" | "report"; path: string }) {
    setSelectedPath(file.path);
    if (file.kind === "source") {
      const f = sources.find((s) => s.path === file.path);
      setPreview(f?.content || "");
    } else if (file.kind === "script") {
      const f = scripts.find((s) => s.path === file.path);
      setPreview(f?.content || "");
    } else if (file.kind === "abi") {
      const f = abis.find((a) => a.path === file.path);
      if (f) setPreview(JSON.stringify({ name: f.name, abi: f.abi }, null, 2));
    } else if (file.kind === "report") {
      setPreview(file.path === "audit.md" ? (auditMd || "") : (complianceMd || ""));
    }
  }

  function selectedFileLabel() {
    const f = displayFiles.find((d) => d.path === selectedPath);
    return f?.label || "";
  }

  function downloadSelected() {
    const name = selectedFileLabel();
    const text = preview || "";
    if (!name || !text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleZipDownload() {
    try {
      const anyFiles = (sources?.length || 0) + (abis?.length || 0) + (scripts?.length || 0);
      if (!anyFiles) return;
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const folder = zip.folder("Contract");
      if (folder) {
        if (sources?.[0]) folder.file("solidity.sol", sources[0].content || "");
        if (abis?.[0]) folder.file("abi.json", JSON.stringify({ name: abis[0].name, abi: abis[0].abi }, null, 2));
        if (scripts?.[0]) folder.file("Script.js", scripts[0].content || "");
        if (auditMd) folder.file("Audit.md", auditMd);
        if (complianceMd) folder.file("Compliance.md", complianceMd);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const srcName = (sources[0]?.path || "").split("/").pop() || "";
      const base = (srcName.replace(/\.[^/.]+$/, "") || selectedFileLabel().replace(/\.[^/.]+$/, "") || "project");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${base}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error("ZIP download failed", e);
    }
  }

  return (
    <div
      className="min-h-screen w-full bg-black relative overflow-hidden"
      ref={containerRef}
    >
      <div
        className="absolute inset-0 z-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 50% 100% at 10% 0%, rgba(226, 232, 240, 0.15), transparent 65%), #000000",
        }}
      />

      <div className="relative z-10 h-screen flex flex-col">
        <ChatIdHeader
          userData={userData}
          onBack={() => router.push("/chat")}
        />

        {/* Main Content Area: left thinking + chat (bottom), right files/preview toggle */}
        <div className="flex-1 p-4 overflow-hidden">
          <div className="h-full w-full grid grid-cols-1 lg:grid-cols-[0.8fr_1.2fr] gap-4">
            {/* Left panel */}
            <div className="min-h-0 bg-black border border-white/10 rounded-xl overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-white/10 bg-black">
                <div className="flex items-center justify-between">
                  <div className="text-base font-semibold text-white drop-shadow-sm">
                    {isDappMode ? "DApp Build" : isFrontendMode ? "Frontend Build" : "Thinking"}
                  </div>
                  <div className="text-xs text-white/60">
                    {(state || "running")}
                    {currentStage ? ` • ${currentStage}` : ""}
                    {progress != null ? ` • ${progress}%` : ""}
                  </div>
                </div>
                <div className="mt-1 text-xs text-white/40 truncate">
                  Job: {chatId}
                </div>
              </div>

              {error && (
                <div className="mx-4 mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                  {error}
                </div>
              )}

              {/* DApp/Frontend info cards */}
              {(isDappMode || isFrontendMode) && (contractAddress || vercelUrl) && (
                <div className="mx-4 mt-3 space-y-2">
                  {contractAddress && (
                    <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                      <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium mb-1">
                        {contractVerified && <ShieldCheck size={14} className="text-emerald-400" />}
                        <span>{contractName || "Smart Contract"}{contractVerified ? " — Verified" : ""}</span>
                      </div>
                      <div className="text-xs text-white/70 font-mono truncate">{contractAddress}</div>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[10px] text-white/40">{contractNetwork}</span>
                        {contractExplorerUrl && (
                          <a
                            href={contractExplorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                          >
                            <ExternalLink size={11} /> Explorer
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                  {vercelUrl && (
                    <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-blue-400 font-medium">Frontend Deployed</span>
                        <a
                          href={vercelUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                        >
                          <Globe size={11} /> Open App <ExternalLink size={10} />
                        </a>
                      </div>
                      <div className="text-xs text-white/60 font-mono truncate mt-1">{vercelUrl}</div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-black px-4 py-4">
                <LogViewer logs={logs} currentStage={currentStage} progress={progress} />
              </div>

              {/* Chat input pinned to bottom */}
              <ChatInput
                input={input}
                wsConnected={true}
                isBuilding={isBuilding}
                onInputChange={setInput}
                onSubmit={handleSendMessage}
                onAttach={handleAttachFiles}
              />
            </div>

            {/* Right panel */}
            <div className="min-h-0 bg-black border border-white/10 rounded-xl overflow-hidden flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-black/20">
                <div className="relative flex items-center rounded-lg bg-black border border-white/10 p-1" style={{ width: 104 }}>
                  {/* sliding active background */}
                  <div
                    className="absolute top-1 left-1 h-9 w-12 bg-white/10 rounded-md shadow transition-transform duration-200"
                    style={{ transform: showPreview ? 'translateX(48px)' : 'translateX(0)' }}
                    aria-hidden
                  />

                  <button
                    type="button"
                    onClick={() => setShowPreview(false)}
                    aria-label="Files"
                    className={`relative z-10 w-12 h-9 flex items-center justify-center rounded-md text-white/70 hover:text-white transition-colors`}
                  >
                    <FileCode className="w-4 h-4" />
                    <span className="sr-only">Files</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowPreview(true)}
                    aria-label="Preview"
                    className={`relative z-10 w-12 h-9 flex items-center justify-center rounded-md text-white/70 hover:text-white transition-colors ml-1`}
                  >
                    <Globe className="w-4 h-4" />
                    <span className="sr-only">Preview</span>
                  </button>
                </div>

                {!showPreview ? (
                  <button
                    onClick={handleZipDownload}
                    className="text-[11px] text-white/70 hover:text-white flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5 disabled:opacity-50"
                    type="button"
                    disabled={(sources.length + abis.length + scripts.length) === 0}
                    title="Download as ZIP"
                  >
                    <Archive size={14} /> ZIP
                  </button>
                ) : appUrl && !isCheckingUrl ? (
                  <button
                    type="button"
                    onClick={() => window.open(appUrl, "_blank")}
                    className="text-[11px] text-white/70 hover:text-white flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5"
                    title="Open preview in new tab"
                  >
                    <Globe size={14} /> Open
                  </button>
                ) : (
                  <div className="text-[11px] text-white/40 px-2">&nbsp;</div>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-hidden">
                {!showPreview ? (
                  isBuilderMode ? (
                    <FileViewer files={projectFiles} projectId={chatId} localFileContent={localFileContent} />
                  ) : (
                    <div className="h-full w-full flex min-h-0">
                      {/* Files tree */}
                      <div className="w-72 border-r border-white/10 bg-black min-h-0 flex flex-col">
                        <button
                          onClick={() => setTreeOpen(!treeOpen)}
                          className="w-full flex items-center gap-2 px-3 py-3 text-xs text-white/80 hover:bg-white/5 border-b border-white/10"
                          type="button"
                        >
                          {treeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <Folder size={14} className="text-white/70" />
                          <span className="text-white">Contract</span>
                        </button>

                        <div className="flex-1 overflow-auto">
                          {treeOpen ? (
                            <ul className="text-xs py-1">
                              {displayFiles.map((f) => (
                                <li key={f.path}>
                                  <button
                                    type="button"
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-white hover:bg-white/10 ${
                                      selectedPath === f.path ? "bg-white/10" : ""
                                    }`}
                                    onClick={() => onSelectDisplayFile(f)}
                                  >
                                    {f.kind === "source" ? (
                                      <FileCode size={14} className="text-pink-300" />
                                    ) : f.kind === "abi" ? (
                                      <FileJson size={14} className="text-yellow-300" />
                                    ) : f.kind === "script" ? (
                                      <FileText size={14} className="text-green-300" />
                                    ) : (
                                      <FileText size={14} className="text-cyan-300" />
                                    )}
                                    <span className="truncate">{f.label}</span>
                                  </button>
                                </li>
                              ))}
                              {displayFiles.length === 0 && (
                                <li className="px-3 py-3 text-white/40">
                                  Files will appear here once artifacts are ready.
                                </li>
                              )}
                            </ul>
                          ) : (
                            <div className="p-3 text-xs text-white/40">Collapsed</div>
                          )}
                        </div>
                      </div>

                      {/* File preview */}
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-black">
                          <div className="flex items-center gap-2 text-xs min-w-0">
                            {selectedPath ? (
                              <>
                                {(() => {
                                  const f = displayFiles.find((d) => d.path === selectedPath);
                                  if (!f) return null;
                                  return f.kind === "source" ? (
                                    <FileCode size={14} className="text-pink-300" />
                                  ) : f.kind === "abi" ? (
                                    <FileJson size={14} className="text-yellow-300" />
                                  ) : f.kind === "script" ? (
                                    <FileText size={14} className="text-green-300" />
                                  ) : (
                                    <FileText size={14} className="text-cyan-300" />
                                  );
                                })()}
                                <span className="text-white/80 truncate">{selectedFileLabel()}</span>
                              </>
                            ) : (
                              <span className="text-white/60">No file selected</span>
                            )}
                          </div>
                          <button
                            onClick={downloadSelected}
                            className="text-[11px] text-white/70 hover:text-white flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5"
                            type="button"
                            disabled={!selectedPath || !preview}
                          >
                            <Download size={14} /> Download
                          </button>
                        </div>

                        {(() => {
                          const f = displayFiles.find((d) => d.path === selectedPath);
                          const isMd = f?.kind === "report" || /\.md$/i.test(f?.label || f?.path || "");
                          if (isMd) {
                            return (
                              <div className="p-4 flex-1 min-h-0 overflow-auto bg-black text-white">
                                <MarkdownViewer content={preview || ""} />
                              </div>
                            );
                          }
                          return (
                            <pre className="p-4 text-xs text-white/90 whitespace-pre-wrap leading-relaxed flex-1 min-h-0 overflow-auto bg-black">
                              {preview || "// Select a file to preview"}
                            </pre>
                          );
                        })()}
                      </div>
                    </div>
                  )
                ) : (
                  <div className="h-full p-6 bg-black">
                    {isCheckingUrl ? (
                      <div className="w-full h-full rounded-lg border border-white/10 bg-black flex items-center justify-center">
                        <div className="text-center">
                          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white/60 mx-auto mb-4" />
                          <p className="text-white/60">Checking if app is ready...</p>
                        </div>
                      </div>
                    ) : appUrl ? (
                      (() => {
                        const isExternal = /^https?:\/\//.test(appUrl) && !appUrl.includes('localhost') && !appUrl.includes('127.0.0.1');
                        if (isExternal) {
                          return (
                            <div className="w-full h-full rounded-lg border border-white/10 bg-black flex items-center justify-center">
                              <div className="text-center max-w-md">
                                <Globe className="w-14 h-14 text-blue-400/60 mx-auto mb-4" />
                                <h3 className="text-lg font-semibold text-white mb-2">App Deployed Successfully</h3>
                                <p className="text-white/50 text-sm mb-1">
                                  Embedded preview is blocked by the hosting provider.
                                </p>
                                <p className="text-white/40 text-xs mb-6">
                                  The deployed site sets <code className="text-white/60 bg-white/5 px-1 rounded">X-Frame-Options: deny</code> which prevents iframe embedding.
                                </p>
                                <a
                                  href={appUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                                >
                                  <ExternalLink size={16} /> Open App in New Tab
                                </a>
                                <p className="text-white/30 text-[11px] font-mono mt-4 truncate">{appUrl}</p>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div className="w-full h-full rounded-lg overflow-hidden border border-white/10 bg-black">
                            <iframe
                              src={appUrl}
                              title="App Preview"
                              className="w-full h-full"
                              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                            />
                          </div>
                        );
                      })()
                    ) : (
                      <div className="w-full h-full rounded-lg border border-white/10 bg-black flex items-center justify-center">
                        <div className="text-center">
                          <Globe className="w-12 h-12 text-white/20 mx-auto mb-4" />
                          <p className="text-white/60">Preview will appear here</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
