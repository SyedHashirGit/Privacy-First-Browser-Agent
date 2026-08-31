import { create } from 'zustand';
import type { AgentMode, TaskState } from './types';
import { on, send, installBusListener } from './bus';

interface AgentStore {
  state: TaskState | null;
  connected: boolean;
  setState: (s: TaskState) => void;
  startTask: (instruction: string, mode: AgentMode) => void;
  stopTask: () => void;
  setMode: (mode: AgentMode) => void;
  confirmAction: (approve: boolean) => void;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  state: null,
  connected: false,

  setState: (s) => set({ state: s, connected: true }),

  startTask: (instruction, mode) => {
    send({ type: 'START_TASK', payload: { instruction, mode } });
  },

  stopTask: () => {
    const taskId = get().state?.taskId;
    if (!taskId) return;
    send({ type: 'STOP_TASK', payload: { taskId } });
  },

  setMode: (mode) => {
    send({ type: 'SET_MODE', payload: { mode } });
  },

  confirmAction: (approve) => {
    const taskId = get().state?.taskId;
    if (!taskId) return;
    send({ type: 'CONFIRM_ACTION', payload: { taskId, approve } });
  },
}));

/** Call once when the side panel / popup mounts. */
export function initStoreSync() {
  installBusListener();
  on('STATE_UPDATE', (msg) => {
    useAgentStore.getState().setState(msg.payload);
  });
  // Pull current state immediately on mount instead of waiting for the next push.
  send({ type: 'GET_STATE' }).then((res) => {
    if (res) useAgentStore.getState().setState(res);
  });
}
