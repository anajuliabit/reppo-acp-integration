import { parseAbi, type Address } from 'viem';

export const POD_CONTRACT: Address = '0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c';
export const REPPO_TOKEN: Address = '0xFf8104251E7761163faC3211eF5583FB3F8583d6';
export const USDC_TOKEN: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const UNISWAP_ROUTER: Address = '0x2626664c2603336E57B271c5C0b26F421741e481'; // SwapRouter02 on Base
export const CHAIN_ID = 8453 as const; // Base
export const EMISSION_SHARE = 50;
export const SWAP_SLIPPAGE_BPS = 100; // 1% slippage tolerance

export const TX_RECEIPT_TIMEOUT = 120_000; // 2 minutes
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY = 1000; // 1 second

export const POD_ABI = parseAbi([
  'function mintPod(address to, uint8 emissionSharePercent) returns (uint256 podId)',
  'function publishingFee() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// Uniswap V3 SwapRouter02 ABI (exactOutputSingle)
export const SWAP_ROUTER_ABI = parseAbi([
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
]);
