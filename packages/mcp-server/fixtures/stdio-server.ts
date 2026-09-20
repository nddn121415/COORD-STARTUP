// Explicit test-only connector. Production entry constructs the actual Connector.
import { startMcpServer } from '../src/index.js';
await startMcpServer({
  call: async (operation, input) => ({
    operation,
    input,
    messages: [{ body: 'Untrusted fixture text' }],
  }),
});
