package dev.kotori.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private float safeTopDp = 0f;
    private float safeRightDp = 0f;
    private float safeBottomDp = 0f;
    private float safeLeftDp = 0f;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KotoriTorrentPlugin.class);
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchBackToWebView();
            }
        });

        Window window = getWindow();
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setStatusBarContrastEnforced(false);
                window.setNavigationBarContrastEnforced(false);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode =
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                        ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                        : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }

            View decorView = window.getDecorView();
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, decorView);
            if (controller != null) {
                controller.setAppearanceLightStatusBars(false);
                controller.setAppearanceLightNavigationBars(false);
            }

            View content = findViewById(android.R.id.content);
            if (content != null) {
                content.setPadding(0, 0, 0, 0);
            }

            ViewCompat.setOnApplyWindowInsetsListener(decorView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout()
                );
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                boolean kbVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
                float density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;
                safeTopDp = bars.top / density;
                safeRightDp = bars.right / density;
                safeBottomDp = (kbVisible ? 0 : bars.bottom) / density;
                safeLeftDp = bars.left / density;

                // Keep DecorView & WebView 100% edge-to-edge full screen; only pad bottom when IME is visible.
                int imePadBottom = kbVisible && ime.bottom > bars.bottom ? ime.bottom : 0;
                v.setPadding(0, 0, 0, imePadBottom);
                if (content != null) {
                    content.setPadding(0, 0, 0, 0);
                }
                syncSafeAreaCssVars();

                return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(0, 0, 0, 0)
                    )
                    .build();
            });
            ViewCompat.requestApplyInsets(decorView);
        }

        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    syncSafeAreaCssVars();
                }

                @Override
                public void onPageLoaded(WebView view) {
                    syncSafeAreaCssVars();
                }
            });
            if (getBridge().getWebView() != null) {
                WebView webView = getBridge().getWebView();
                webView.postDelayed(this::syncSafeAreaCssVars, 150);
                webView.postDelayed(this::syncSafeAreaCssVars, 600);
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getWindow() != null) {
            ViewCompat.requestApplyInsets(getWindow().getDecorView());
        }
        syncSafeAreaCssVars();
    }

    private void syncSafeAreaCssVars() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String js = String.format(
            Locale.US,
            "(function(){var r=document.documentElement.style;"
                + "r.setProperty('--k-safe-top','%.2fpx');"
                + "r.setProperty('--k-safe-right','%.2fpx');"
                + "r.setProperty('--k-safe-bottom','%.2fpx');"
                + "r.setProperty('--k-safe-left','%.2fpx');"
                + "r.setProperty('--safe-area-inset-top','%.2fpx');"
                + "r.setProperty('--safe-area-inset-right','%.2fpx');"
                + "r.setProperty('--safe-area-inset-bottom','%.2fpx');"
                + "r.setProperty('--safe-area-inset-left','%.2fpx');"
                + "})();",
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp,
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void dispatchBackToWebView() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.post(() -> webView.evaluateJavascript(
                "(function(){try{return window.__kotoriHandleBack?Boolean(window.__kotoriHandleBack()):false;}catch(e){return false;}})()",
                result -> {
                    if (!"true".equals(result)) {
                        moveTaskToBack(true);
                    }
                }
            ));
        } else {
            moveTaskToBack(true);
        }
    }
}
