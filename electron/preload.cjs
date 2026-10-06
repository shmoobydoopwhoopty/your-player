const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('afterglowDesktop', {
  homePath: (() => { try { return require('node:os').homedir() } catch { return '' } })(),
  removeTrackedFolder: folder => ipcRenderer.invoke('afterglow:remove-tracked-folder', folder),
  getPathForFile: file => { try { return webUtils.getPathForFile(file) } catch { return '' } },
  chooseAudioFiles: () => ipcRenderer.invoke('afterglow:choose-audio'),
  chooseMusicFolder: () => ipcRenderer.invoke('afterglow:choose-folder'),
  getTrackedFolders: () => ipcRenderer.invoke('afterglow:get-tracked-folders'),
  cancelFolderScan: () => ipcRenderer.send('afterglow:cancel-folder'),
  onFolderBatch: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('afterglow:folder-batch', listener);
    return () => ipcRenderer.removeListener('afterglow:folder-batch', listener);
  },
  onFolderProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('afterglow:folder-progress', listener);
    return () => ipcRenderer.removeListener('afterglow:folder-progress', listener);
  },
  restoreAudioFiles: paths => ipcRenderer.invoke('afterglow:restore-files', paths),
  refreshFiles: folders => ipcRenderer.invoke('afterglow:refresh-files', folders),
  onRefreshBatch: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('afterglow:refresh-batch', listener);
    return () => ipcRenderer.removeListener('afterglow:refresh-batch', listener);
  },
  onRefreshDone: callback => {
    const listener = (_event, folders) => callback(folders);
    ipcRenderer.on('afterglow:refresh-done', listener);
    return () => ipcRenderer.removeListener('afterglow:refresh-done', listener);
  },
  getPlayableUrl: path => ipcRenderer.invoke('afterglow:playable-url', path),
  readAudioBytes: (path, start, end) => ipcRenderer.invoke('afterglow:read-bytes', path, start, end),

  // Frameless window controls
  windowControls: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:maximize-toggle'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximize: callback => {
      const listener = (_event, maximized) => callback(maximized);
      ipcRenderer.on('win:maximized', listener);
      return () => ipcRenderer.removeListener('win:maximized', listener);
    },
  },

  // Downloader & Media
  renameApp: value => ipcRenderer.invoke('player:apply-brand', value),
  chooseDirectory: title => ipcRenderer.invoke('afterglow:choose-dir', title),
  getDownloadsDir: () => ipcRenderer.invoke('player:get-downloads-dir'),
  setDownloadsDir: dir => ipcRenderer.invoke('player:set-downloads-dir', dir),
  initDownloader: payload => ipcRenderer.invoke('player:downloader-init', payload ?? null),
  searchYouTube: query => ipcRenderer.invoke('player:search', query),
  searchSuggestions: query => ipcRenderer.invoke('player:suggest', query),
  startDownload: payload => ipcRenderer.invoke('player:download', payload),
  downloadActive: () => ipcRenderer.invoke('player:active'),
  cancelDownloads: id => ipcRenderer.invoke('player:cancel', id ?? null),
  listMediaFiles: () => ipcRenderer.invoke('player:list-media'),
  listMediaFilesWithThumbs: () => ipcRenderer.invoke('player:media-list-with-thumbs'),
  getCookieHeader: () => ipcRenderer.invoke('player:get-cookie-header'),
  getMediaUrl: filePath => ipcRenderer.invoke('player:media-url', filePath),
  deleteMediaFile: filePath => ipcRenderer.invoke('player:media-delete', filePath),
  onDownloadProgress: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('player:progress', listener);
    return () => ipcRenderer.removeListener('player:progress', listener);
  },

  // Artist photos (display-only lookup cache; never edits files or tags)
  getArtistPhoto: name => ipcRenderer.invoke('artist-photo:get', name),
  refetchArtistPhoto: name => ipcRenderer.invoke('artist-photo:refetch', name),
  chooseArtistPhoto: name => ipcRenderer.invoke('artist-photo:choose-custom', name),
  removeArtistPhoto: name => ipcRenderer.invoke('artist-photo:remove', name),

  // Editing song details (writes tags into the music files)
  writeTrackTags: payload => ipcRenderer.invoke('tracks:write-tags', payload),
  writeTrackArt: payload => ipcRenderer.invoke('tracks:write-art', payload),
  trimMediaFile: payload => ipcRenderer.invoke('player:trim', payload),
  chooseImageFile: title => ipcRenderer.invoke('afterglow:choose-image', title),

  // Custom app logo
  saveAppLogo: payload => ipcRenderer.invoke('app-logo:save', payload),
  clearAppLogo: () => ipcRenderer.invoke('app-logo:clear'),

  // YouTube sign in for the downloader
  libraryLoad: () => ipcRenderer.invoke('library:load'),
  librarySave: data => ipcRenderer.invoke('library:save', data),
  youtubeSignIn: () => ipcRenderer.invoke('youtube:signin'),
  youtubeSigninStatus: () => ipcRenderer.invoke('youtube:signin-status'),
  youtubeSignOut: () => ipcRenderer.invoke('youtube:signout'),

  // Self-update
  updateGetConfig: () => ipcRenderer.invoke('update:get-config'),
  updateSetConfig: partial => ipcRenderer.invoke('update:set-config', partial),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateRelaunch: () => ipcRenderer.send('update:relaunch'),
  onUpdateStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
