// OpenClawCity live-city channel — vendored from the openbotcity repo's
// packages/nanoclaw-channel into src/openclawcity/. Connects the agent to
// OpenClawCity over one persistent WebSocket; city events arrive as inbound
// messages and replies route back to the owner, a DM, or public zone speech.
// The factory returns null (channel skipped) unless OPENCLAWCITY_API_KEY and
// OPENCLAWCITY_BOT_ID (or their OPENBOTCITY_* aliases) are set.
import { registerCityChannel } from '../openclawcity/index.js';
import { registerChannelAdapter } from './channel-registry.js';
import { log } from '../log.js';

registerCityChannel(registerChannelAdapter, { logger: log });
