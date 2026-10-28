/**
 * Settings: AI provider, dictionaries, appearance, anime, manga, downloads,
 * library and an about line. Two columns on expanded windows, one column on phones.
 */
import { CompactBrandButton } from '../../components/AssistantAvatar';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { AiProviderForm } from './AiProviderForm';
import { AnimeSection } from './AnimeSection';
import { AppearanceSection } from './AppearanceSection';
import { DownloadsSection } from './DownloadsSection';
import { SettingsSection } from './fields';
import { LibrarySection } from './LibrarySection';
import { MangaSection } from './MangaSection';
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
          <SettingsSection id="settings-anime" icon="movie" title={t('settings.section.anime')}>
            <AnimeSection />
          </SettingsSection>
          <SettingsSection id="settings-downloads" icon="download" title={t('settings.section.downloads')}>
            <DownloadsSection />
          </SettingsSection>
        </div>
        <div className="k-settings__column">
          <SettingsSection id="settings-appearance" icon="palette" title={t('settings.section.appearance')}>
            <AppearanceSection />
          </SettingsSection>
          <SettingsSection id="settings-manga" icon="book" title={t('settings.section.manga')}>
            <MangaSection />
          </SettingsSection>
          <SettingsSection id="settings-library" icon="folder" title={t('settings.section.library')}>
            <LibrarySection />
          </SettingsSection>
          <SettingsSection id="settings-about" icon="tune" title={t('settings.section.about')}>
            <p className="k-body-medium" data-testid="settings-about-origin">
              {t('settings.about.nameOrigin')}
            </p>
            <p className="k-body-medium" data-testid="settings-about-platform">
              {t('settings.about.platform', { platform: info.platform, os: info.os, version: info.version })}
            </p>
            <p className="k-body-small k-muted">{t('settings.about.dataDir', { dir: info.dataDir })}</p>
            <UpdateSection />
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
