package dev.kotori.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class FeedbackEmailIntentBuilderTest {

    private static final String SELF = "dev.kotori.app";

    @Test
    public void mailtoUri_encodesRecipient() {
        assertEquals("mailto:agent@example.com", FeedbackEmailIntentBuilder.mailtoUri(" agent@example.com "));
        assertEquals("mailto:", FeedbackEmailIntentBuilder.mailtoUri(null));
        assertEquals("mailto:a%20b@example.com", FeedbackEmailIntentBuilder.mailtoUri("a b@example.com"));
    }

    @Test
    public void normalizeMime_fallsBackToImageWildcard() {
        assertEquals("image/png", FeedbackEmailIntentBuilder.normalizeMime("image/png"));
        assertEquals("image/jpeg", FeedbackEmailIntentBuilder.normalizeMime(" IMAGE/JPEG "));
        assertEquals("image/*", FeedbackEmailIntentBuilder.normalizeMime(null));
        assertEquals("image/*", FeedbackEmailIntentBuilder.normalizeMime("application/pdf"));
        assertEquals("image/*", FeedbackEmailIntentBuilder.normalizeMime("image/"));
    }

    @Test
    public void orderEmailPackages_prefersConcreteMailtoDefault() {
        List<String> ordered = FeedbackEmailIntentBuilder.orderEmailPackages(
            "com.microsoft.office.outlook",
            "com.microsoft.office.outlook.compose.ComposeLauncherActivity",
            Arrays.asList("com.google.android.gm", "com.microsoft.office.outlook"),
            SELF
        );
        assertEquals(Arrays.asList("com.microsoft.office.outlook", "com.google.android.gm"), ordered);
    }

    @Test
    public void orderEmailPackages_skipsSystemResolverAndPrefersGmail() {
        List<String> ordered = FeedbackEmailIntentBuilder.orderEmailPackages(
            "android",
            "com.android.internal.app.ResolverActivity",
            Arrays.asList("com.example.mail", "com.google.android.gm", "com.example.mail", SELF),
            SELF
        );
        assertEquals(Arrays.asList("com.google.android.gm", "com.example.mail"), ordered);

        assertTrue(FeedbackEmailIntentBuilder.orderEmailPackages(
            "com.android.intentresolver", "com.android.intentresolver.ChooserActivity", null, SELF
        ).isEmpty());
    }

    @Test
    public void isConcreteEmailApp_filtersColorOsAndChooserResolvers() {
        assertFalse(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.oplus.resolver", null, SELF));
        assertFalse(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.vendor.intentresolver", null, SELF));
        assertFalse(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.foo", "com.foo.ResolverActivity", SELF));
        assertFalse(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.foo", "com.foo.ChooserActivity", SELF));
        assertFalse(FeedbackEmailIntentBuilder.isConcreteEmailApp(SELF, null, SELF));
        assertFalse(FeedbackEmailIntentBuilder.isConcreteEmailApp("  ", null, SELF));
        assertTrue(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.google.android.gm", null, SELF));
        assertTrue(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.android.email", "com.android.email.ComposeActivity", SELF));
    }

    @Test
    public void orderEmailPackages_colorOsResolverDefaultFallsBackToOtherHandlers() {
        List<String> ordered = FeedbackEmailIntentBuilder.orderEmailPackages(
            "com.oplus.resolver",
            "com.oplus.resolver.OplusResolverActivity",
            Arrays.asList("com.oplus.resolver", "com.android.email", "com.netease.mail"),
            SELF
        );
        assertEquals(Arrays.asList("com.android.email", "com.netease.mail"), ordered);
    }

    @Test
    public void sendTypeCandidates_startWithAttachmentType() {
        assertEquals(
            Arrays.asList("image/jpeg", "image/*", "*/*", "message/rfc822"),
            FeedbackEmailIntentBuilder.sendTypeCandidates("image/jpeg")
        );
        assertEquals(
            Arrays.asList("image/*", "*/*", "message/rfc822"),
            FeedbackEmailIntentBuilder.sendTypeCandidates(null)
        );
    }

    @Test
    public void plan_directPackageFirstThenSelectorThenChooser() {
        List<FeedbackEmailIntentBuilder.Spec> plan = FeedbackEmailIntentBuilder.plan(
            Collections.singletonList(new FeedbackEmailIntentBuilder.SendTarget(
                "com.google.android.gm", "com.google.android.gm.ComposeActivityGmailExternal", "image/jpeg"
            )),
            "agent@example.com",
            "image/jpeg"
        );
        assertEquals(3, plan.size());

        FeedbackEmailIntentBuilder.Spec direct = plan.get(0);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.DIRECT_PACKAGE, direct.strategy);
        assertEquals("image/jpeg", direct.type);
        assertEquals("com.google.android.gm", direct.packageName);
        assertEquals("com.google.android.gm.ComposeActivityGmailExternal", direct.className);
        assertNull(direct.selectorMailto);
        assertFalse(direct.hasSelector());
        assertEquals("email", direct.mode());

        FeedbackEmailIntentBuilder.Spec selector = plan.get(1);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.MAILTO_SELECTOR, selector.strategy);
        assertNull("selector fallback must not call setType", selector.type);
        assertFalse(selector.hasType());
        assertEquals("mailto:agent@example.com", selector.selectorMailto);
        assertNull(selector.packageName);
        assertEquals("email", selector.mode());

        FeedbackEmailIntentBuilder.Spec chooser = plan.get(2);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.CHOOSER, chooser.strategy);
        assertEquals("image/jpeg", chooser.type);
        assertNull(chooser.selectorMailto);
        assertEquals("chooser", chooser.mode());
    }

    @Test
    public void plan_withoutResolvedEmailAppStartsWithSelector() {
        List<FeedbackEmailIntentBuilder.Spec> plan = FeedbackEmailIntentBuilder.plan(null, "a@b.co", "image/png");
        assertEquals(2, plan.size());
        assertEquals(FeedbackEmailIntentBuilder.Strategy.MAILTO_SELECTOR, plan.get(0).strategy);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.CHOOSER, plan.get(1).strategy);
    }

    @Test
    public void plan_packageOnlyTargetWhenSeveralSendActivities() {
        List<FeedbackEmailIntentBuilder.Spec> plan = FeedbackEmailIntentBuilder.plan(
            Arrays.asList(
                new FeedbackEmailIntentBuilder.SendTarget("com.android.email", null, "*/*"),
                null
            ),
            "",
            "image/png"
        );
        assertEquals(3, plan.size());
        assertEquals("com.android.email", plan.get(0).packageName);
        assertNull(plan.get(0).className);
        assertEquals("*/*", plan.get(0).type);
        assertEquals("mailto:", plan.get(1).selectorMailto);
    }

    @Test
    public void spec_rejectsTypePlusSelector() {
        try {
            new FeedbackEmailIntentBuilder.Spec(
                FeedbackEmailIntentBuilder.Strategy.MAILTO_SELECTOR, "image/png", null, null, "mailto:"
            );
            fail("type + selector must be rejected");
        } catch (IllegalStateException expected) {
            // expected
        }
        try {
            new FeedbackEmailIntentBuilder.Spec(
                FeedbackEmailIntentBuilder.Strategy.DIRECT_PACKAGE, "image/png", null, "com.x.Compose", null
            );
            fail("className without packageName must be rejected");
        } catch (IllegalStateException expected) {
            // expected
        }
    }
}
