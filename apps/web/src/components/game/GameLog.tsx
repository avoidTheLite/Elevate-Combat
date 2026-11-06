import type { GameState, Team } from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { InterfaceDialog } from '../ui/InterfaceDialog.tsx';

export function GameLog({
  game,
  view,
  onClose,
}: {
  game: GameState;
  view: Team | null;
  onClose: () => void;
}): React.ReactElement {
  const tactical = game.battle?.log ?? [];
  const visible = (team: Team): boolean => view === null || !game.settings.fog || team === view;
  const hideCombatDetails = view !== null && game.settings.fog;
  return (
    <InterfaceDialog label="Game log" onClose={onClose}>
      <div className="flex items-center justify-between">
        <h2>GAME LOG</h2>
        <Button size="sm" onClick={onClose} autoFocus>
          CLOSE LOG
        </Button>
      </div>
      {game.battle && (
        <section>
          <h3>COMBAT LOG</h3>
          {hideCombatDetails && (
            <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
              Detailed combat messages are withheld under fog. Visible target calculations remain
              available in Context.
            </p>
          )}
          {!hideCombatDetails && (
            <ol className="text-[11px] leading-5">
              {tactical
                .filter((entry) => visible(entry.team))
                .slice(-100)
                .reverse()
                .map((entry, i) => (
                  <li key={i}>
                    R{entry.round} {entry.text}
                  </li>
                ))}
            </ol>
          )}
        </section>
      )}
      <section>
        <h3>CAMPAIGN LOG</h3>
        <ol className="text-[11px] leading-5">
          {game.log
            .filter((entry) => visible(entry.team))
            .slice(-100)
            .reverse()
            .map((entry, i) => (
              <li key={i}>
                T{entry.turn} {entry.text}
              </li>
            ))}
        </ol>
      </section>
    </InterfaceDialog>
  );
}
