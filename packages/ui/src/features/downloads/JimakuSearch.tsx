/**
 * Jimaku subtitle search: entries → files → download. A missing API key
 * surfaces a call-to-action that jumps to the settings page.
 */
import { useState } from 'react';
import type { JimakuEntry, JimakuFile } from '@kotori/core';
import { Button } from '../../components/m3/Button';
import { Icon } from '../../components/m3/Icon';
import { List, ListItem } from '../../components/m3/List';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { useRouteStore } from '../../app/routes';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { formatBytes, formatDate } from './format';
import { useDownloadsStore } from './useDownloadsStore';

export function JimakuSearch() {
  const host = useHost();
  const t = useT();
  const upsert = useDownloadsStore((s) => s.upsert);
  const setTab = useRouteStore((s) => s.setTab);
  const hasKey = useSettingsStore((s) => s.settings.anime.jimakuApiKey.trim().length > 0);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<readonly JimakuEntry[] | undefined>();
  const [entry, setEntry] = useState<JimakuEntry | undefined>();
  const [files, setFiles] = useState<readonly JimakuFile[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; auth: boolean } | undefined>();

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setLoading(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      setError({ message: e instanceof Error ? e.message : String(e), auth: code === 'ai-auth' });
      return undefined;
    } finally {
      setLoading(false);
    }
  };

  const search = async (): Promise<void> => {
    setEntry(undefined);
    setFiles(undefined);
    const r = await run(() => host.downloads.searchJimaku({ query: query.trim() }));
    if (r) setEntries(r);
  };

  const openEntry = async (e: JimakuEntry): Promise<void> => {
    setEntry(e);
    const r = await run(() => host.downloads.listJimakuFiles(e.id));
    if (r) setFiles(r);
  };

  const download = async (file: JimakuFile): Promise<void> => {
    if (!entry) return;
    try {
      const task = await host.downloads.start({ source: { kind: 'jimaku', entry, file }, title: file.name, autoImport: true });
      upsert(task);
      showSnackbar(t('downloads.nyaa.started', { title: file.name }));
    } catch (err) {
      showSnackbar(t('common.error', { message: err instanceof Error ? err.message : String(err) }), { tone: 'error' });
    }
  };

  const keyCta = (
    <div className="k-dl-cta" role="alert">
      <Icon name="key" />
      <span>{t('downloads.jimaku.noKey')}</span>
      <Button variant="tonal" onClick={() => setTab('settings')}>
        {t('downloads.jimaku.goSettings')}
      </Button>
    </div>
  );

  return (
    <section className="k-dl-search">
      {!hasKey && keyCta}
      <form
        className="k-dl-search__bar"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <TextField label={t('downloads.jimaku.placeholder')} value={query} onValueChange={setQuery} leadingIcon="search" type="search" />
        <Button type="submit" icon="search" disabled={loading}>
          {t('common.search')}
        </Button>
      </form>
      {loading && <LinearProgress label={t('common.loading')} />}
      {error && (error.auth ? hasKey && keyCta : <p className="k-error-text">{t('common.error', { message: error.message })}</p>)}

      {entry ? (
        <div className="k-stack">
          <div className="k-row">
            <Button variant="text" icon="back" onClick={() => setEntry(undefined)}>
              {t('common.back')}
            </Button>
            <h3 className="k-title-medium">
              {entry.japaneseName ?? entry.name} · {t('downloads.jimaku.files')}
            </h3>
          </div>
          {files && files.length === 0 && <p className="k-empty">{t('downloads.noResults')}</p>}
          <List>
            {(files ?? []).map((f) => (
              <ListItem
                key={f.url}
                leading={<Icon name={f.isTextSubtitle ? 'subtitles' : 'folder'} />}
                headline={f.name}
                supporting={[
                  f.episode !== undefined ? t('downloads.jimaku.episode', { n: f.episode }) : f.archiveFormat ? t('downloads.jimaku.archive') : '',
                  formatBytes(f.sizeBytes),
                  formatDate(f.lastModifiedAt),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  <Button variant="tonal" icon="download" disabled={!f.isTextSubtitle && f.archiveFormat !== 'zip'} onClick={() => void download(f)}>
                    {t('downloads.nyaa.download')}
                  </Button>
                }
              />
            ))}
          </List>
        </div>
      ) : (
        <>
          {entries && entries.length === 0 && <p className="k-empty">{t('downloads.noResults')}</p>}
          <List>
            {(entries ?? []).map((e) => (
              <ListItem
                key={e.id}
                leading={<Icon name="subtitles" />}
                headline={e.japaneseName ?? e.name}
                supporting={[e.englishName ?? e.name, e.anilistId ? `AniList ${e.anilistId}` : '', e.flags.unverified ? 'unverified' : ''].filter(Boolean).join(' · ')}
                trailing={<Icon name="chevronRight" />}
                onClick={() => void openEntry(e)}
              />
            ))}
          </List>
        </>
      )}
    </section>
  );
}
