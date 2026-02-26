// Web3 & WalletConnect configuration for EVM chains
import { defaultWagmiConfig } from '@web3modal/wagmi';
import { mainnet, polygon } from 'wagmi/chains';

export const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo';

export const chains = [mainnet, polygon];

export const wagmiConfig = defaultWagmiConfig({
  projectId,
  chains,
  metadata: {
    name: 'Ginie',
    description: 'Ginie Wallet Login',
    url: process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3100',
    icons: [
      (process.env.NEXT_PUBLIC_BASE_URL ? `${process.env.NEXT_PUBLIC_BASE_URL}` : '') + '/logo.png'
    ],
  },
});
