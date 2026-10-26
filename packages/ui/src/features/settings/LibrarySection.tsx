/** Library roots (anime / manga folders) with a path-browser / native-picker dialog. */
import { useState } from 'react';
import { Button } from '../../components/m3/Button';
import { Dialog } from '../../components/m3/Dialog';
import { Icon } from '../../components/m3/Icon';
import { IconButton } from '../../components/m3/IconButton';
import { List, ListItem } from '../../components/m3/List';
import { PathBrowser } from '../../components/PathBrowser';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { usePatchSettings } from './fields';

type RootKind = 'animeRoots' | 'mangaRoots';

export function LibrarySection() {
  const t = useT();
  const library = useSettingsStore((s) => s.settings.library);
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
