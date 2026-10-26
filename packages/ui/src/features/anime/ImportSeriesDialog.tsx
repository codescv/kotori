/** Import an anime folder (desktop path browser or Android directory picker). */
import { useState } from 'react';
import { useRouteStore } from '../../app/routes';
import { PathBrowser } from '../../components/PathBrowser';
import { Button } from '../../components/m3/Button';
import { Dialog } from '../../components/m3/Dialog';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';

export function ImportSeriesDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const host = useHost();
  const t = useT();
  const openAnime = useRouteStore((s) => s.openAnime);
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const series = await host.anime.importSeries({ path, ...(title.trim() ? { titleOverride: title.trim() } : {}) });
      onClose();
      setPath('');
      setTitle('');
      openAnime({ kind: 'series', seriesId: series.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('anime.import.title')}
      icon="folder"
      wide
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!path || busy} onClick={() => void submit()}>
            {t('common.import')}
          </Button>
        </>
      }
    >
      <PathBrowser value={path} onChange={setPath} select="dir" />
      <TextField label={t('anime.import.titleOverride')} value={title} onValueChange={setTitle} />
      {busy && <LinearProgress />}
      {error && <p className="k-error-text">{error}</p>}
    </Dialog>
  );
}
