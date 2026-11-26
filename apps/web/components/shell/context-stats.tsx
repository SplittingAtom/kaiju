"use client";

import type { ThreadStats } from "@kaiju/protocol";
import { useEffect, useRef, useState } from "react";
import { NOT_RECORDED, eventsNote, statGroups } from "../../lib/chat/context-stats";
import styles from "./context-viewer.module.css";

type StatsRead = (() => Promise<ThreadStats | null> | null) | undefined;

/**
 * Reads the stats on open and with each refresh of the panel (`attempt`). Never throws:
 * `undefined` while the first read is out, null when it failed.
 */
export function useStatsRead(read: StatsRead, attempt: number): ThreadStats | null | undefined {
  const [stats, setStats] = useState<ThreadStats | null | undefined>(undefined);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    let current = true;
    const pending = readRef.current?.();
    if (pending === undefined || pending === null) return;
    void pending.then(
      (s) => {
        if (current) setStats(s);
      },
      () => {
        if (current) setStats(null);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);
  return stats;
}

/**
 * Conversation stats (KOBE-842) under the Context panel's gauge and legend: four groups of
 * figures, each a definition list; every figure carries a tooltip saying what it means (also
 * read out after the value). A figure Kaiju does not have reads "Not recorded", never 0.
 */
export function ContextStats({ stats }: { readonly stats: ThreadStats | null | undefined }) {
  if (stats === undefined) {
    return (
      <section className={styles.stats} aria-label="Conversation stats" data-context-stats>
        <p className={styles.statsStatus} role="status">
          Reading the stats…
        </p>
      </section>
    );
  }
  if (stats === null) {
    return (
      <section className={styles.stats} aria-label="Conversation stats" data-context-stats>
        <p className={styles.statsStatus} role="status">
          The stats could not be read. Refresh to try again.
        </p>
      </section>
    );
  }
  const note = eventsNote(stats);
  return (
    <section className={styles.stats} aria-labelledby="context-stats-title" data-context-stats>
      <h2 id="context-stats-title" className={styles.statsTitle}>
        Conversation stats
      </h2>
      {statGroups(stats).map((group) => (
        <div key={group.id} className={styles.statsGroup} data-stats-group={group.id}>
          <h3 id={`context-stats-${group.id}`} className={styles.statsGroupTitle}>
            {group.title}
          </h3>
          <dl className={styles.statsList} aria-labelledby={`context-stats-${group.id}`}>
            {group.rows.map((row) => (
              <div key={row.id} className={styles.statsRow} data-stat={row.id}>
                <dt className={styles.statsTerm} title={row.hint}>
                  {row.term}
                </dt>
                <dd
                  className={styles.statsValue}
                  title={row.hint}
                  data-not-recorded={row.value === null || undefined}
                >
                  <span data-stat-value>{row.value ?? NOT_RECORDED}</span>
                  <span className="sr-only">. {row.hint}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {note !== null && (
        <p className={styles.statsNote} role="note">
          {note}
        </p>
      )}
    </section>
  );
}
