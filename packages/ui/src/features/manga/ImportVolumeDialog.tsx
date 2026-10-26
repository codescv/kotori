/**
 * Import a manga volume: `.mokuro` (+ page images), `.cbz`/`.zip`, or an image
 * directory. Uses the shared PathBrowser (server path browser on desktop,
 * native pickers on Android).
 */
import { useEffect, useState } from 'react';
import type { MangaVolume } from '@kotori/core';
import { PathBrowser } from '../../components/PathBrowser';
import { Button } from '../../components/m3/Button';
import { Dialog } from '../../components/m3/Dialog';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';

export interface ImportVolumeDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onImported: (volume: MangaVolume) => void;
}

export function ImportVolumeDialog({ open, onClose, onImported }: ImportVolumeDialogProps) {
  const host = useHost();
  const t = useT();
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (open) {
      setPath('');
      setTitle('');
      setError(undefined);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    if (!path) return;
    setBusy(true);
    setError(undefined);
    try {
      const v = await host.manga.importVolume(title.trim() ? { path, titleOverride: title.trim() } : { path });
      onImported(v);
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
      title={t('manga.import.title')}
      wide
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!path || busy}>
            {busy ? t('common.loading') : t('common.import')}
          </Button>
        </>
      }
    >
      <p className="k-muted">{t('manga.import.hint')}</p>
      <PathBrowser value={path} onChange={setPath} select="any" accept={['mokuro', 'cbz', 'zip']} />
      <TextField label={t('anime.import.titleOverride')} value={title} onValueChange={setTitle} />
      {error && <p className="k-error-text">{error}</p>}
    </Dialog>
  );
}
