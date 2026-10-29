/** Library folders (anime / manga), download directory, Jimaku subtitles and mirror URLs. */
import { useState } from 'react';
import { Button } from '../../components/m3/Button';
import { Dialog } from '../../components/m3/Dialog';
import { Icon } from '../../components/m3/Icon';
import { IconButton } from '../../components/m3/IconButton';
import { List, ListItem } from '../../components/m3/List';
import { Switch } from '../../components/m3/Switch';
import { PathBrowser } from '../../components/PathBrowser';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { CommitTextField, SettingsDisclosure, usePatchSettings } from './fields';

type RootKind = 'animeRoots' | 'mangaRoots';

const isHttpUrl = (v: string): boolean => /^https?:\/\/\S+$/i.test(v.trim());

export function MediaSection() {
  const t = useT();
  const host = useHost();
  const torrent = host.info.capabilities.torrent;
  const library = useSettingsStore((s) => s.settings.library);
  const dl = useSettingsStore((s) => s.settings.downloads);
  const anime = useSettingsStore((s) => s.settings.anime);
  const patch = usePatchSettings();
  const [adding, setAdding] = useState<RootKind | undefined>();
  const [chosen, setChosen] = useState('');

  const setRoots = (kind: RootKind, roots: readonly string[]): void => void patch({ library: { [kind]: roots } });

  const block = (kind: RootKind, label: string) => (
    <div className="k-settings-field" data-testid={`roots-${kind}`}>
      <div className="k-row">
        <span className="k-label-large">{label}</span>
        <span className="k-spacer" />
        <Button
          variant="text"
          icon="add"
          onClick={() => {
            setChosen('');
            setAdding(kind);
          }}
        >
          {t('settings.library.add')}
        </Button>
      </div>
      {library[kind].length === 0 ? (
        <p className="k-muted k-body-medium">{t('settings.library.empty')}</p>
      ) : (
        <List>
          {library[kind].map((root) => (
            <ListItem
              key={root}
              leading={<Icon name="folder" />}
              headline={<code className="k-settings-path">{root}</code>}
              trailing={<IconButton icon="delete" size="small" label={t('common.delete')} onClick={() => setRoots(kind, library[kind].filter((r) => r !== root))} />}
            />
          ))}
        </List>
      )}
    </div>
  );

  return (
    <div className="k-stack">
      {block('animeRoots', t('settings.library.animeRoots'))}
      {block('mangaRoots', t('settings.library.mangaRoots'))}
      <CommitTextField
        label={t('settings.downloads.dir')}
        value={dl.downloadDir}
        onCommit={(downloadDir) => void patch({ downloads: { downloadDir: downloadDir.trim() } })}
        validate={(v) => (v.trim() ? undefined : t('settings.ai.required'))}
      />
      <Switch
        label={t('settings.anime.autoJimaku')}
        checked={anime.autoDownloadJimaku}
        onChange={(autoDownloadJimaku) => void patch({ anime: { autoDownloadJimaku } })}
      />
      <CommitTextField
        label={t('settings.anime.jimakuKey')}
        type="password"
        value={anime.jimakuApiKey}
        supportingText={t('settings.anime.jimakuKeyHelp')}
        onCommit={(jimakuApiKey) => void patch({ anime: { jimakuApiKey: jimakuApiKey.trim() } })}
      />
      <SettingsDisclosure testId="media-advanced-disclosure">
        {torrent && (
          <CommitTextField
            label={t('settings.downloads.nyaa')}
            type="url"
            value={dl.nyaaBaseUrl}
            validate={(v) => (isHttpUrl(v) ? undefined : t('settings.invalidUrl'))}
            onCommit={(nyaaBaseUrl) => void patch({ downloads: { nyaaBaseUrl: nyaaBaseUrl.trim() } })}
          />
        )}
        <CommitTextField
          label={t('settings.downloads.mokuro')}
          type="url"
          value={dl.mokuroCatalogUrl}
          validate={(v) => (isHttpUrl(v) ? undefined : t('settings.invalidUrl'))}
          onCommit={(mokuroCatalogUrl) => void patch({ downloads: { mokuroCatalogUrl: mokuroCatalogUrl.trim() } })}
        />
      </SettingsDisclosure>
      <Dialog
        open={adding !== undefined}
        onClose={() => setAdding(undefined)}
        title={t('settings.library.add')}
        icon="folder"
        wide
        actions={
          <>
            <Button variant="text" onClick={() => setAdding(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!chosen}
              onClick={() => {
                if (adding && chosen && !library[adding].includes(chosen)) setRoots(adding, [...library[adding], chosen]);
                setAdding(undefined);
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <PathBrowser value={chosen} onChange={setChosen} select="dir" />
      </Dialog>
    </div>
  );
}
