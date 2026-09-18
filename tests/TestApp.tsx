import App from '../src/App';
import { TEST_ACCOUNT } from './accountFixture';

/** Existing workflow tests opt into the simulator; the production surface does not. */
export default function TestApp() {
  return <App initialAccount={TEST_ACCOUNT} showDeveloperTools />;
}
