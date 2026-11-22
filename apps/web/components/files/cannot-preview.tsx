"use client";

import { DownloadIcon } from "lucide-react";
import { Button } from "../ui/button";

/** A file the tab does not show: why, and Download right there (the header has it too). */
export function CannotPreview({
  reason,
  onDownload,
}: {
  readonly reason: string;
  onDownload?: (() => void) | undefined;
}) {
  return (
    <div role="status" className="flex flex-col items-start gap-2 text-sm">
      <p className="text-muted-foreground">{`${reason} Use Download to get it.`}</p>
      {onDownload && (
        <Button type="button" variant="outline" size="sm" onClick={onDownload}>
          <DownloadIcon aria-hidden />
          Download
        </Button>
      )}
    </div>
  );
}
