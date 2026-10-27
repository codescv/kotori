package dev.kotori.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
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
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller != null) {
                controller.setAppearanceLightStatusBars(false);
                controller.setAppearanceLightNavigationBars(false);
            }
        }

        View content = findViewById(android.R.id.content);
        if (content != null) {
            ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout()
                );
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                float density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;
                safeTopDp = bars.top / density;
                safeRightDp = bars.right / density;
                safeBottomDp = bars.bottom / density;
                safeLeftDp = bars.left / density;

                // Keep WebView 100% edge-to-edge full screen; only pad bottom when keyboard (IME) is visible.
                int imePadBottom = ime.bottom > bars.bottom ? ime.bottom : 0;
                v.setPadding(0, 0, 0, imePadBottom);
                syncSafeAreaCssVars();
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(content);
        }

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.postDelayed(this::syncSafeAreaCssVars, 150);
            webView.postDelayed(this::syncSafeAreaCssVars, 600);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
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
                + "})();",
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
