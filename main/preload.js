'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) {
    const err = new Error((res && res.error) || '操作失败');
    if (res && res.detail) err.detail = res.detail;
    throw err;
  }
  return res.data;
}

function subscribe(channel, callback) {
  const handler = (event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  app: {
    getState: () => invoke('app:getState'),
    saveSettings: (patch) => invoke('app:saveSettings', patch),
    chooseDirectory: (options) => invoke('app:chooseDirectory', options),
    chooseFile: (options) => invoke('app:chooseFile', options),
    copyText: (text) => invoke('app:copyText', text),
    openExternal: (url) => invoke('app:openExternal', url),
    openPath: (target) => invoke('app:openPath', target),
    showItemInFolder: (target) => invoke('app:showItemInFolder', target),
    openUserData: () => invoke('app:openUserData'),
  },
  providers: {
    list: () => invoke('providers:list'),
    save: (payload) => invoke('providers:save', payload),
    clearKey: (id) => invoke('providers:clearKey', id),
    removeCustom: (id) => invoke('providers:removeCustom', id),
    clearAllKeys: () => invoke('providers:clearAllKeys'),
    fetchModels: (payload) => invoke('providers:fetchModels', payload),
  },
  chat: {
    list: () => invoke('chat:list'),
    get: (id) => invoke('chat:get', id),
    create: (payload) => invoke('chat:create', payload),
    update: (payload) => invoke('chat:update', payload),
    delete: (id) => invoke('chat:delete', id),
    clear: () => invoke('chat:clear'),
    send: (payload) => invoke('chat:send', payload),
    abort: (id) => invoke('chat:abort', id),
    export: (id) => invoke('chat:export', id),
    loopStart: (payload) => invoke('chat:loopStart', payload),
    loopStop: (id) => invoke('chat:loopStop', id),
    loopState: () => invoke('chat:loopState'),
    onEvent: (callback) => subscribe('chat:event', callback),
  },
  mcp: {
    list: () => invoke('mcp:list'),
    save: (payload) => invoke('mcp:save', payload),
    remove: (id) => invoke('mcp:remove', id),
    start: (id) => invoke('mcp:start', id),
    stop: (id) => invoke('mcp:stop', id),
    restart: (id) => invoke('mcp:restart', id),
    tools: (id) => invoke('mcp:tools', id),
    importWorkflow: () => invoke('mcp:importWorkflow'),
  },
  workflow: {
    getState: () => invoke('workflow:getState'),
    install: (payload) => invoke('workflow:install', payload),
    createProject: (payload) => invoke('workflow:createProject', payload),
    switchProject: (name) => invoke('workflow:switchProject', name),
    saveProfile: (data) => invoke('workflow:saveProfile', data),
    getProfile: () => invoke('workflow:getProfile'),
    previewRequirement: (data) => invoke('workflow:previewRequirement', data),
    createRequirement: (data) => invoke('workflow:createRequirement', data),
    listTerminal: () => invoke('workflow:listTerminal'),
    readTerminal: (name) => invoke('workflow:readTerminal', name),
    appendDecision: (payload) => invoke('workflow:appendDecision', payload),
    stationAction: (payload) => invoke('workflow:stationAction', payload),
    pause: () => invoke('workflow:pause'),
    resume: () => invoke('workflow:resume'),
    tidy: (payload) => invoke('workflow:tidy', payload),
    clearLocks: (payload) => invoke('workflow:clearLocks', payload),
    selfCheck: () => invoke('workflow:selfCheck'),
    getTemplates: () => invoke('workflow:getTemplates'),
    getDocs: () => invoke('workflow:getDocs'),
    readDoc: (filePath) => invoke('workflow:readDoc', filePath),
    getMcp: () => invoke('workflow:getMcp'),
    pythonCommand: () => invoke('workflow:pythonCommand'),
    onProgress: (callback) => subscribe('workflow:progress', callback),
  },
});
