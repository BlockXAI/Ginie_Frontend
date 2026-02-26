 # Ginie Frontend (BlockXAI)

 Ginie is a Next.js (App Router) frontend for BlockXAI that provides OTP-based authentication, an AI smart-contract / deployment workflow UI, job tracking, artifacts viewing, and wallet connectivity.

 [![Repo](https://img.shields.io/badge/GitHub-BlockXAI%2FGinie__Frontend-black)](https://github.com/BlockXAI/Ginie_Frontend)

 ## Quick Links

 - **Repository**: https://github.com/BlockXAI/Ginie_Frontend
 - **Docs (in this repo)**:
   - `docs/AI_Deployment_API.md`
   - `docs/AI_Deploy_UI_UX_Guide.md`
   - `docs/Technical_Overview.md`

 ## Tech Stack

 - **Framework**: Next.js 15 (App Router)
 - **Language**: TypeScript + React
 - **UI**: TailwindCSS + shadcn/ui (Radix)
 - **Web3**: wagmi + web3modal (WalletConnect)

 ## Local Development

 ### Prerequisites

 - Node.js 20+
 - npm

 ### Install

 ```bash
 npm ci
 ```

 ### Run

 The dev server runs on **port 3100**.

 ```bash
 npm run dev
 ```

 ### Build / Start

 ```bash
 npm run build
 npm run start
 ```

 ## Routing

 Key routes in this app:

 - `/` Home / marketing
 - `/signin` OTP sign-in
 - `/signup` OTP sign-up
 - `/projects` Projects / jobs list
 - `/chat` Chat / pipeline UI
 - `/chat/[id]` Job / chat detail
 - `/profile` Profile (includes wallet connect)
 - `/subscription` Subscription

 Redirects:

 - `/pipeline` redirects to `/smart-contract` (configured in `next.config.js`). If you change the canonical route, update `next.config.js`.

 ## Backend / API Integration

 All browser requests go through the local Next.js proxy route to preserve cookies:

 - **Proxy route**: `app/api/proxy/[...path]/route.ts`
 - **Browser base**: `/api/proxy`

 Server-side / deployment base URL is configured via:

 - `NEXT_PUBLIC_API_BASE_URL`

 If `NEXT_PUBLIC_API_BASE_URL` is not set, the code falls back to the default currently hardcoded in:

 - `lib/api.ts`
 - `app/api/proxy/[...path]/route.ts`

 ## Environment Variables

 Create a `.env.local` in the repo root as needed.

 Common variables:

 - `NEXT_PUBLIC_API_BASE_URL` (optional; upstream user-api base URL used by the proxy)
 - `NEXT_PUBLIC_SITE_URL` (optional; used for sitemap base URL)
 - `NEXT_PUBLIC_BASE_URL` (optional; used in WalletConnect metadata; defaults to `http://localhost:3100`)
 - `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (required for WalletConnect in production)

 ## Web3 / WalletConnect

 Wallet configuration lives in:

 - `lib/web3.ts`

 It uses `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` and sets Ginie-branded metadata for wallet prompts.

 ## Documentation

 - `docs/wallet-based-deployment/` contains wallet-deployment integration docs.

 ## Troubleshooting

 ### Port 3100 already in use

 If `npm run dev` fails with `EADDRINUSE: address already in use :::3100`, either:

 - Stop the process using port 3100, or
 - Change the port in `package.json` scripts (`next dev -p 3100`).
