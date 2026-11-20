import { formatAddress, toBaseUrl } from '../server/core/address';
import type { ConnectionSnapshot } from '../server/core/connectionMachine';
import { serverConnection } from '../server/ServerConnection';
import { BaseProvider } from './BaseProvider';
import type { LocalizationContext, ProviderId, Unsubscribe } from './types';

/**
 * Self-hosted localization server on the local network.
 *
 * STAGE 2a (this file): CONNECTIVITY ONLY. The provider follows the app's server
 * connection (`server/ServerConnection.ts`) and reports whether the server is reachable.
 * It never emits a pose.
 *
 * STAGE 2b (not implemented): while `connected`, send camera frames with the camera pose
 * of the current session to `POST {baseUrl}/localize` (to be added to
 * `server/core/client.ts`, the only module that talks HTTP), turn the answer into the
 * doorway pose in the session frame and `emitPose` it.
 */
export class SelfHostedServerProvider extends BaseProvider {
  readonly id: ProviderId = 'self-hosted';
  readonly displayName = 'Self-hosted server (connectivity only)';

  private unsubscribe: Unsubscribe | null = null;

  /** `http://host:port` of the connected server, or null. For stage 2b. */
  getBaseUrl(): string | null {
    return serverConnection.getBaseUrl();
  }

  protected onStart(_context: LocalizationContext): void {
    this.unsubscribe = serverConnection.subscribe((view) => this.follow(view.connection));
    this.follow(serverConnection.getView().connection);
  }

  protected onStop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  relocalize(): void {
    this.context?.log('self-hosted: localisation is not implemented yet (stage 2b)');
  }

  private follow(connection: ConnectionSnapshot): void {
    const { state, address, info } = connection;
    if (state === 'connected' && address) {
      this.setStatus(
        'connected',
        `connected to ${info?.serverName ?? 'server'} (${toBaseUrl(address)}), ` +
          'localisation not implemented yet (stage 2b)',
      );
      return;
    }
    const where = address ? ` ${formatAddress(address)}` : '';
    switch (state) {
      case 'not-configured':
        this.setStatus('waiting-for-server', 'no server address - tap the server chip to set it up');
        break;
      case 'searching':
        this.setStatus('waiting-for-server', 'searching for the server');
        break;
      case 'connecting':
        this.setStatus('waiting-for-server', `connecting to${where}`);
        break;
      case 'incompatible':
        this.setStatus('error', `incompatible server at${where}: ${connection.detail}`);
        break;
      default:
        this.setStatus('waiting-for-server', `server${where} unreachable: ${connection.detail}`);
    }
  }
}
