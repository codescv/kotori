/**
 * Settings: 5 focused cards (AI provider, dictionaries, learning & reading,
 * appearance, library & downloads) plus a full-width about/update footer.
 * Two columns on expanded windows, one column on phones.
 */
import { CompactBrandButton } from '../../components/AssistantAvatar';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { AiProviderForm } from './AiProviderForm';
import { AppearanceSection } from './AppearanceSection';
import { SettingsSection } from './fields';
import { LearningSection } from './LearningSection';
import { MediaSection } from './MediaSection';
import { DictionarySection } from './sections/DictionarySection';
import { UpdateSection } from '../updater/UpdateBanner';
import './settings.css';

export function SettingsPage() {
  const t = useT();
  const host = useHost();
  const info = host.info;
  return (
    <div className="k-page k-settings">
      <header className="k-page__header">
        <CompactBrandButton />
        <h1 className="k-headline-small">{t('settings.title')}</h1>
      </header>
      <div className="k-settings__columns">
        <div className="k-settings__column">
          <SettingsSection id="settings-ai" icon="sparkle" title={t('settings.section.ai')}>
            <AiProviderForm />
          </SettingsSection>
          <SettingsSection id="settings-dictionary" icon="book" title={t('settings.section.dictionary')}>
            <DictionarySection />
          </SettingsSection>
          <SettingsSection id="settings-learning" icon="translate" title={t('settings.section.learning')}>
            <LearningSection />
          </SettingsSection>
        </div>
        <div className="k-settings__column">
          <SettingsSection id="settings-appearance" icon="palette" title={t('settings.section.appearance')}>
            <AppearanceSection />
          </SettingsSection>
          <SettingsSection id="settings-media" icon="folder" title={t('settings.section.media')}>
            <MediaSection />
          </SettingsSection>
        </div>
      </div>
      <footer id="settings-about" data-testid="settings-about" className="k-settings__footer">
        <UpdateSection />
        <div className="k-settings__footer-meta k-body-small k-muted">
          <p data-testid="settings-about-origin">{t('settings.about.nameOrigin')}</p>
          <p>
            <span data-testid="settings-about-platform">
              {t('settings.about.platform', { platform: info.platform, os: info.os, version: info.version })}
            </span>
            {' · '}
            <span>{t('settings.about.dataDir', { dir: info.dataDir })}</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
