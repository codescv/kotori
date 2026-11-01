/**
 * Footer control + M3 dialog for configuring the local-only Agent Feedback Email
 * (`localStorage` key `kotori_agent_feedback_email`) and launching a pre-prefixed
 * `kotori: [vX.Y.Z] <summary>` email to the Vibe Coding dispatcher.
 */
import { useState } from 'react';
import { Button } from '../../components/m3/Button';
import { Dialog } from '../../components/m3/Dialog';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { showSnackbar } from '../../stores/snackbar';
import {
  AGENT_FEEDBACK_EMAIL_PLACEHOLDER,
  buildAgentFeedbackMailto,
  buildAgentFeedbackSubject,
  deriveFeedbackSummary,
  isValidFeedbackEmail,
  launchAgentFeedbackMailto,
  readAgentFeedbackEmail,
  writeAgentFeedbackEmail,
} from './agentFeedback';

export function AgentFeedbackSection() {
  const t = useT();
  const host = useHost();
  const [open, setOpen] = useState(false);
  const [savedEmail, setSavedEmail] = useState<string>(() => readAgentFeedbackEmail());
  const [email, setEmail] = useState<string>(() => readAgentFeedbackEmail());
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [summaryError, setSummaryError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const openDialog = (): void => {
    const current = readAgentFeedbackEmail();
    setSavedEmail(current);
    setEmail(current);
    setEmailError(undefined);
    setSummaryError(undefined);
    setOpen(true);
  };

  const closeDialog = (): void => {
    setOpen(false);
    setEmailError(undefined);
    setSummaryError(undefined);
  };

  const handleSaveEmail = (): void => {
    const trimmed = email.trim();
    if (trimmed === '') {
      writeAgentFeedbackEmail('');
      setSavedEmail('');
      setEmail('');
      setEmailError(undefined);
      showSnackbar(t('settings.feedback.emailCleared'), { tone: 'info' });
      return;
    }
    if (!isValidFeedbackEmail(trimmed)) {
      setEmailError(t('settings.feedback.emailInvalid'));
      return;
    }
    const persisted = writeAgentFeedbackEmail(trimmed);
    setSavedEmail(persisted);
    setEmail(persisted);
    setEmailError(undefined);
    showSnackbar(t('settings.feedback.emailSaved'), { tone: 'info' });
  };

  const handleSend = async (): Promise<void> => {
    const trimmedEmail = email.trim();
    if (!isValidFeedbackEmail(trimmedEmail)) {
      setEmailError(t('settings.feedback.emailInvalid'));
      return;
    }
    if (summary.trim().length === 0 && details.trim().length === 0) {
      setSummaryError(t('settings.feedback.summaryRequired'));
      return;
    }
    const persisted = writeAgentFeedbackEmail(trimmedEmail);
    setSavedEmail(persisted);
    setEmail(persisted);
    setEmailError(undefined);
    setSummaryError(undefined);

    const mailtoUrl = buildAgentFeedbackMailto({
      email: persisted,
      summary,
      details,
      version: host.info.version,
      platform: host.info.platform,
      os: host.info.os,
    });

    setSending(true);
    try {
      await launchAgentFeedbackMailto(host, mailtoUrl);
      showSnackbar(t('settings.feedback.launched'), { tone: 'info' });
      setSummary('');
      setDetails('');
      setOpen(false);
    } catch (e) {
      showSnackbar(e instanceof Error ? e.message : String(e), { tone: 'error' });
    } finally {
      setSending(false);
    }
  };

  const previewSummary = deriveFeedbackSummary(summary, details);
  const previewSubject = buildAgentFeedbackSubject(previewSummary, host.info.version, host.info.platform);

  return (
    <div className="k-agent-feedback" data-testid="settings-agent-feedback">
      <div className="k-agent-feedback__row">
        <div className="k-agent-feedback__status">
          <span className="k-label-large">{t('settings.feedback.title')}</span>
          <span className="k-body-small k-muted" data-testid="agent-feedback-status">
            {savedEmail
              ? t('settings.feedback.statusConfigured', { email: savedEmail })
              : t('settings.feedback.statusUnconfigured')}
          </span>
        </div>
        <div className="k-agent-feedback__actions">
          <Button
            variant="tonal"
            icon="send"
            onClick={openDialog}
            data-testid="open-agent-feedback-btn"
          >
            {t('settings.feedback.trigger')}
          </Button>
        </div>
      </div>

      <Dialog
        open={open}
        onClose={closeDialog}
        title={t('settings.feedback.dialogTitle')}
        icon="send"
        className="k-agent-feedback-dialog"
        data-testid="agent-feedback-dialog"
        actions={
          <>
            <Button variant="text" onClick={closeDialog}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="tonal"
              onClick={handleSaveEmail}
              data-testid="save-agent-feedback-email-btn"
            >
              {t('settings.feedback.saveEmail')}
            </Button>
            <Button
              variant="filled"
              icon="send"
              disabled={sending}
              onClick={() => void handleSend()}
              data-testid="send-agent-feedback-btn"
            >
              {t('settings.feedback.sendEmail')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('settings.feedback.emailLabel')}
          placeholder={AGENT_FEEDBACK_EMAIL_PLACEHOLDER}
          type="email"
          autoComplete="email"
          value={email}
          onValueChange={(next) => {
            setEmail(next);
            if (emailError) setEmailError(undefined);
          }}
          error={emailError}
          supportingText={t('settings.feedback.emailHelp')}
          data-testid="agent-feedback-email-input"
        />
        <TextField
          label={t('settings.feedback.summaryLabel')}
          placeholder={t('settings.feedback.summaryPlaceholder')}
          value={summary}
          onValueChange={(next) => {
            setSummary(next);
            if (summaryError) setSummaryError(undefined);
          }}
          error={summaryError}
          data-testid="agent-feedback-summary-input"
        />
        <TextField
          label={t('settings.feedback.detailsLabel')}
          placeholder={t('settings.feedback.detailsPlaceholder')}
          multiline
          rows={4}
          value={details}
          onValueChange={(next) => {
            setDetails(next);
            if (summaryError) setSummaryError(undefined);
          }}
          supportingText={t('settings.feedback.subjectPreview', { subject: previewSubject })}
          data-testid="agent-feedback-details-input"
        />
      </Dialog>
    </div>
  );
}
