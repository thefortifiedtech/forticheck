import { Connection, PublicKey } from '@solana/web3.js';
import { 
  getMint, 
  ExtensionType, 
  getExtensionData,
  getTransferFeeConfig,
  getDefaultAccountState,
  AccountState
} from '@solana/spl-token';

export interface SafetyReport {
  mintAddress: string;
  isToken2022: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  hasPermanentDelegate: boolean;
  permanentDelegate: string | null;
  isHighRisk: boolean;
  transferFeeBasisPoints: number;
  isTaxToken: boolean;
  defaultAccountState: string;
  isHoneypot: boolean;
  error?: string;
}

/**
 * Audits a given Solana Token Mint using Helius DAS API and Token-2022 extensions.
 * @param connection The Solana RPC connection
 * @param mintAddressString The base58 string of the mint address
 * @param heliusRpcUrl The Helius RPC URL for DAS API
 * @returns A SafetyReport object
 */
export async function auditTokenExtensions(connection: Connection, mintAddressString: string, heliusRpcUrl?: string): Promise<SafetyReport> {
  const defaultReport: SafetyReport = {
    mintAddress: mintAddressString,
    isToken2022: false,
    mintAuthority: null,
    freezeAuthority: null,
    hasPermanentDelegate: false,
    permanentDelegate: null,
    isHighRisk: false,
    transferFeeBasisPoints: 0,
    isTaxToken: false,
    defaultAccountState: 'Uninitialized',
    isHoneypot: false
  };

  try {
    const mintPublicKey = new PublicKey(mintAddressString);
    let isToken2022 = false;
    let mintAuth: string | null = null;
    let freezeAuth: string | null = null;

    if (heliusRpcUrl) {
        // Use Helius DAS API
        const response = await fetch(heliusRpcUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'my-id',
                method: 'getAsset',
                params: { id: mintAddressString }
            }),
        });
        const { result } = await response.json();
        
        if (!result) {
            return { ...defaultReport, error: "Asset not found on Helius." };
        }

        const tokenInfo = result.token_info;
        if (tokenInfo) {
            isToken2022 = tokenInfo.token_program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
            mintAuth = tokenInfo.mint_authority;
            freezeAuth = tokenInfo.freeze_authority;
        }
    } else {
        // Fallback to standard RPC
        const accountInfo = await connection.getAccountInfo(mintPublicKey);
        if (!accountInfo) {
            return { ...defaultReport, error: "Account not found." };
        }
        const programId = accountInfo.owner;
        isToken2022 = programId.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
        
        const mintInfo = await getMint(connection, mintPublicKey, connection.commitment, programId);
        mintAuth = mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : null;
        freezeAuth = mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toBase58() : null;
    }

    const report: SafetyReport = {
      ...defaultReport,
      isToken2022,
      mintAuthority: mintAuth,
      freezeAuthority: freezeAuth,
    };

    if (isToken2022) {
      // For Token-2022 extensions, we still need getMint to parse the raw TLV data
      const programId = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
      const mintInfo = await getMint(connection, mintPublicKey, connection.commitment, programId);

      if (mintInfo.tlvData) {
      // 1. Permanent Delegate
      try {
        const permanentDelegateData = getExtensionData(ExtensionType.PermanentDelegate, mintInfo.tlvData);
        if (permanentDelegateData) {
            report.hasPermanentDelegate = true;
            report.permanentDelegate = new PublicKey(permanentDelegateData.slice(0, 32)).toBase58();
            report.isHighRisk = true; // Flag as HIGH RISK
        }
      } catch (e) {
        // Extension not found or error parsing
      }

      // 2. Transfer Fee Config
      try {
        const transferFeeConfig = getTransferFeeConfig(mintInfo);
        if (transferFeeConfig) {
          const feeBps = transferFeeConfig.newerTransferFee.transferFeeBasisPoints;
          report.transferFeeBasisPoints = feeBps;
          if (feeBps > 500) { // > 5% = > 500 basis points
            report.isTaxToken = true;
          }
        }
      } catch (e) {
        // Extension not found or error parsing
      }

      // 3. Default Account State
      try {
        const defaultAccountStateExt = getDefaultAccountState(mintInfo);
        if (defaultAccountStateExt) {
          if (defaultAccountStateExt.state === AccountState.Frozen) {
            report.defaultAccountState = 'Frozen';
            report.isHoneypot = true;
          } else if (defaultAccountStateExt.state === AccountState.Initialized) {
            report.defaultAccountState = 'Initialized';
          }
        }
      } catch (e) {
        // Extension not found or error parsing
      }
    }
    }

    return report;
    
  } catch (error: any) {
    return {
      ...defaultReport,
      error: error.message || 'Unknown error occurred while fetching token data.'
    };
  }
}
