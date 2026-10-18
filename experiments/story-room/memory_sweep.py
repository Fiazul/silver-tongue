"""Incremental, single-flight background extraction of visible conversations."""
import logging
import health
import threading
import time

import life_memory

LOG = logging.getLogger(__name__)
EXTRACTION_LOCK = threading.Lock()
COOLDOWNS = {}


def settings(config):
    values = dict(enabled=False, every=8, provider='fallback', max_batch=30,
                  initial_backlog=120, timeout_seconds=120)
    if not isinstance(config, dict):
        raise ValueError('memory_sweep must be an object')
    values.update(config)
    if (type(values['enabled']) is not bool or values['provider'] != 'fallback' or
            any(type(values[key]) is not int or values[key] < 1
                for key in ('every', 'max_batch', 'initial_backlog')) or
            type(values['timeout_seconds']) not in (int, float) or
            not 0 < values['timeout_seconds'] <= 3600):
        raise ValueError('memory_sweep requires positive batch/backlog/every, timeout <=3600, and provider=fallback')
    return values


def pending_messages(agent, messages, store, state, initial_backlog):
    watermark = int(state.get('watermark', 0)) if state.get('boundary') == store.boundary else 0
    pending = sorted((m for m in life_memory.visible_messages(messages, agent['name'], store.boundary)
                      if message_number(m) > watermark), key=message_number)
    skipped = max(0, len(pending) - initial_backlog) if not state or state.get('boundary') != store.boundary else 0
    return pending, skipped


def observe_backlog(agent, messages, store, config):
    # Atomic state replacement makes this read safe without creating a store lock file.
    state = store._read('state.json', {})
    pending, skipped = pending_messages(agent, messages, store, state, settings(config)['initial_backlog'])
    health.sweep_backlog(agent['name'], len(pending) - skipped)


def message_number(message):
    try:
        return int(message.get('id', 0))
    except (TypeError, ValueError):
        return 0


def maybe_schedule(agent, worker, config, messages, store, invoke, note='', on_failure=None):
    """on_failure(exc) records provider failures so quota/timeouts back off the shared provider."""
    config = settings(config)
    if not config['enabled'] or COOLDOWNS.get(str(store.directory), 0) > time.monotonic():
        return None
    if not EXTRACTION_LOCK.acquire(blocking=False):
        return None
    try:
        with store.lock:
            state = store._read('state.json', {})
            if state.get('boundary') != store.boundary:
                state = {}
            pending, skipped = pending_messages(agent, messages, store, state, config['initial_backlog'])
            if not store.current():
                EXTRACTION_LOCK.release()
                return None
            if skipped:
                state = dict(boundary=store.boundary, watermark=str(message_number(pending[skipped - 1])),
                             processed=0, catchup_skipped=skipped)
                store._write('state.json', state)
                pending = pending[skipped:]
                LOG.info('%s memory sweep catch-up skipped %s older messages covered by one-time backfill',
                         agent['name'], skipped)
        health.sweep_backlog(agent['name'], len(pending))
    except Exception:
        EXTRACTION_LOCK.release()
        raise
    # Drain the tail of a previously split batch even when it is below `every`.
    if not pending or (len(pending) < config['every'] and not state.get('remaining_backlog')):
        EXTRACTION_LOCK.release()
        return None
    batch = pending[:config['max_batch']]

    def run():
        try:
            import backfill_memory
            extracted = backfill_memory.extract_messages(worker, batch, note, chunk_chars=None,
                timeout=config['timeout_seconds'], invoke=invoke, hold_lock=False)
            if not store.current():
                return
            backfill_memory.publish(store, extracted)
            with store.lock:
                if store.current():
                    remaining = len(pending) - len(batch)
                    store._write('state.json', dict(boundary=store.boundary,
                        watermark=str(max(map(message_number, batch))),
                        processed=(state.get('processed', 0) if state.get('boundary') == store.boundary else 0) + len(batch),
                        catchup_skipped=state.get('catchup_skipped', 0), remaining_backlog=remaining))
                    health.sweep_backlog(agent['name'], remaining)
                    health.emit('memory_sweep_success', agent['name'],
                                f'memory sweep processed {len(batch)} messages; {remaining} remaining',
                                chunk_size=len(batch), remaining_backlog=remaining)
        except Exception as exc:
            COOLDOWNS[str(store.directory)] = time.monotonic() + 60
            health.emit('memory_sweep_failure', agent['name'], f'memory sweep failed; {len(pending)} remaining',
                        chunk_size=len(batch), remaining_backlog=len(pending))
            LOG.warning('%s memory sweep failed: %s', agent['name'], exc)
            if on_failure:
                try:
                    on_failure(exc)
                except Exception:
                    LOG.exception('Recording memory sweep failure failed')
        finally:
            EXTRACTION_LOCK.release()
    thread = threading.Thread(target=run, name='memory-sweep-' + agent['name'], daemon=True)
    try:
        thread.start()
    except RuntimeError:
        EXTRACTION_LOCK.release()
        raise
    return thread
