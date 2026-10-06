package com.yourplayer.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(TreeNativePlugin.class);
    super.onCreate(savedInstanceState);
    // Let the player auto-advance and the Downloader preview play without a
    // fresh user gesture inside the WebView.
    if (bridge != null && bridge.getWebView() != null) {
      bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
  }
}
