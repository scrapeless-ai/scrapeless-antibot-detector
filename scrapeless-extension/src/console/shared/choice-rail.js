/**
 * Console choice rails.
 *
 * Keeps the native <select> as the form/state authority while replacing its
 * browser-owned popup with one keyboard-operable Console surface. Dynamic
 * panes are covered by the registry observer, so Rules, Settings and Captures
 * cannot drift into separate select implementations again.
 */
(function installConsoleChoiceRails(globalScope) {
  'use strict';

  const mountedChoices = new WeakMap();
  let choiceSequence = 0;
  let openChoice = null;
  let openCondition = null;

  const nextIdentity = (stem) => {
    choiceSequence += 1;
    return `${stem}-${choiceSequence}`;
  };

  const isElementVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
  };

  const associatedLabel = (select) => {
    const nativeLabel = select.labels?.[0];
    if (nativeLabel) return nativeLabel;
    const fieldRegion = select.closest(
      '.form-group, .setting-row, .setting-option, .setting-group, .network-form-group, .history-v2-field, .capture-filter-group',
    );
    return fieldRegion?.querySelector(
      '.form-label, .setting-row-label, .setting-label, .network-form-label, .history-v2-label, .capture-filter-label',
    ) || null;
  };

  const accessibleName = (select) => {
    const explicit = select.getAttribute('aria-label');
    if (explicit) return explicit;
    const label = associatedLabel(select);
    const labelSelector = '.form-label, .setting-row-label, .setting-label, .network-form-label, .history-v2-label, .capture-filter-label';
    const matchedLabel = label?.matches?.(labelSelector)
      ? label
      : label?.querySelector?.(`:scope > ${labelSelector.split(', ').join(', :scope > ')}`);
    const compactLabel = matchedLabel?.matches?.('.setting-label')
      ? matchedLabel.querySelector(':scope > span:not(.setting-description)') || matchedLabel
      : matchedLabel;
    const labelCopy = compactLabel?.textContent?.trim()
      || [...(label?.childNodes || [])]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(' ');
    if (labelCopy) return labelCopy;
    const fallback = select.title || select.name || select.id;
    return fallback
      ? fallback.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim()
      : 'Choose an option';
  };

  const selectedOption = (select) => select.options[select.selectedIndex] || select.options[0] || null;

  const closeChoiceRail = (record, restoreFocus = false) => {
    if (!record) return;
    record.shell.classList.remove('is-open');
    record.trigger.setAttribute('aria-expanded', 'false');
    record.trigger.removeAttribute('aria-activedescendant');
    record.menu.hidden = true;
    record.activePosition = -1;
    record.typeaheadBuffer = '';
    clearTimeout(record.typeaheadTimer);
    if (openChoice === record) openChoice = null;
    if (restoreFocus) record.trigger.focus();
  };

  const placeFloatingMenu = (trigger, menu) => {
    if (!isElementVisible(trigger)) return;
    const viewportPadding = 8;
    const triggerBox = trigger.getBoundingClientRect();
    const menuWidth = Math.min(
      Math.max(Math.min(triggerBox.width, 360), 176),
      Math.max(176, window.innerWidth - (viewportPadding * 2)),
    );
    const left = Math.min(
      Math.max(viewportPadding, triggerBox.left),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const owningSheet = trigger.closest('.rule-modal-content, .base-modal-content, .history-modal-container, .detection-modal-container');
    const sheetHeader = owningSheet?.querySelector('.rule-modal-header, .modal-header, .history-modal-header, .detection-modal-header');
    const sheetFooter = owningSheet?.querySelector('.rule-modal-footer, .modal-footer');
    const topBoundary = Math.max(
      viewportPadding,
      isElementVisible(sheetHeader) ? sheetHeader.getBoundingClientRect().bottom + 4 : viewportPadding,
    );
    const bottomBoundary = Math.min(
      window.innerHeight - viewportPadding,
      isElementVisible(sheetFooter) ? sheetFooter.getBoundingClientRect().top - 4 : window.innerHeight - viewportPadding,
    );
    const roomBelow = bottomBoundary - triggerBox.bottom;
    const roomAbove = triggerBox.top - topBoundary;
    const availableHeight = Math.max(96, Math.min(260, Math.max(roomBelow, roomAbove)));

    menu.style.left = `${Math.round(left)}px`;
    menu.style.width = `${Math.round(menuWidth)}px`;
    menu.style.maxHeight = `${Math.floor(availableHeight)}px`;

    const measuredHeight = Math.min(menu.scrollHeight, availableHeight);
    const useUpperLane = roomBelow < measuredHeight && roomAbove > roomBelow;
    const top = useUpperLane
      ? Math.max(topBoundary, triggerBox.top - measuredHeight - 4)
      : Math.min(bottomBoundary - measuredHeight, triggerBox.bottom + 4);
    menu.style.top = `${Math.round(top)}px`;
  };

  const paintChoiceOptions = (record) => {
    const { select, menu } = record;
    const fragment = document.createDocumentFragment();
    const painted = [];
    let visiblePosition = 0;

    const paintOption = (option, groupDisabled = false) => {
      if (option.hidden) return;
      const item = document.createElement('div');
      const optionId = nextIdentity('console-choice-option');
      const sequence = String(visiblePosition + 1).padStart(2, '0');
      item.id = optionId;
      item.className = 'console-choice-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      item.setAttribute('aria-disabled', option.disabled || groupDisabled ? 'true' : 'false');
      item.dataset.optionIndex = String(option.index);
      item.dataset.sequence = sequence;
      item.textContent = option.label || option.textContent || option.value;
      if (option.selected) item.classList.add('is-selected');
      if (option.disabled || groupDisabled) item.classList.add('is-disabled');
      item.addEventListener('pointerdown', (event) => event.preventDefault());
      item.addEventListener('click', () => {
        if (item.classList.contains('is-disabled')) return;
        commitChoice(record, Number(item.dataset.optionIndex));
      });
      painted.push(item);
      fragment.appendChild(item);
      visiblePosition += 1;
    };

    [...select.children].forEach((child) => {
      if (child instanceof HTMLOptGroupElement) {
        const group = document.createElement('div');
        group.className = 'console-choice-group';
        group.setAttribute('role', 'group');
        const groupLabel = document.createElement('div');
        const groupLabelId = nextIdentity('console-choice-group');
        groupLabel.id = groupLabelId;
        groupLabel.className = 'console-choice-group-label';
        groupLabel.textContent = child.label;
        group.setAttribute('aria-labelledby', groupLabelId);
        group.appendChild(groupLabel);
        [...child.children].forEach((option) => {
          const before = fragment.childNodes.length;
          paintOption(option, child.disabled);
          if (fragment.childNodes.length > before) {
            group.appendChild(fragment.lastChild);
          }
        });
        fragment.appendChild(group);
        return;
      }
      if (child instanceof HTMLOptionElement) paintOption(child);
    });

    menu.replaceChildren(fragment);
    record.optionNodes = painted;
    const selectedPosition = painted.findIndex((item) => item.classList.contains('is-selected'));
    record.activePosition = selectedPosition >= 0 ? selectedPosition : painted.findIndex((item) => !item.classList.contains('is-disabled'));
  };

  const refreshChoiceRail = (record) => {
    const option = selectedOption(record.select);
    record.value.textContent = option ? (option.label || option.textContent || option.value) : '—';
    record.trigger.disabled = record.select.disabled;
    record.trigger.setAttribute('aria-label', accessibleName(record.select));
    record.trigger.setAttribute('aria-required', record.select.required ? 'true' : 'false');
    if (record.select.getAttribute('aria-invalid')) {
      record.trigger.setAttribute('aria-invalid', record.select.getAttribute('aria-invalid'));
    } else {
      record.trigger.removeAttribute('aria-invalid');
    }
    paintChoiceOptions(record);
    if (record.shell.classList.contains('is-open')) {
      markActiveChoice(record, Math.max(0, record.activePosition));
      requestAnimationFrame(() => placeFloatingMenu(record.trigger, record.menu));
    }
  };

  const markActiveChoice = (record, position) => {
    const candidates = record.optionNodes || [];
    if (!candidates.length) return;
    const direction = position >= record.activePosition ? 1 : -1;
    let cursor = Math.max(0, Math.min(position, candidates.length - 1));
    while (candidates[cursor]?.classList.contains('is-disabled')) {
      cursor += direction;
      if (cursor < 0 || cursor >= candidates.length) return;
    }
    candidates.forEach((item, index) => item.classList.toggle('is-active', index === cursor));
    record.activePosition = cursor;
    const active = candidates[cursor];
    record.trigger.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  };

  const openChoiceRail = (record) => {
    if (record.select.disabled) return;
    if (openChoice && openChoice !== record) closeChoiceRail(openChoice);
    if (openCondition) closeConditionMenu(openCondition);
    refreshChoiceRail(record);
    record.shell.classList.add('is-open');
    record.trigger.setAttribute('aria-expanded', 'true');
    record.menu.hidden = false;
    openChoice = record;
    const initial = record.optionNodes.findIndex((item) => item.classList.contains('is-selected'));
    markActiveChoice(record, initial >= 0 ? initial : 0);
    requestAnimationFrame(() => placeFloatingMenu(record.trigger, record.menu));
  };

  const commitChoice = (record, optionIndex) => {
    const option = record.select.options[optionIndex];
    if (!option || option.disabled) return;
    const changed = record.select.selectedIndex !== optionIndex;
    record.select.selectedIndex = optionIndex;
    refreshChoiceRail(record);
    closeChoiceRail(record, true);
    if (changed) {
      record.select.dispatchEvent(new Event('input', { bubbles: true }));
      record.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const stepChoice = (record, delta) => {
    if (!record.shell.classList.contains('is-open')) openChoiceRail(record);
    const baseline = record.activePosition >= 0 ? record.activePosition : 0;
    markActiveChoice(record, baseline + delta);
  };

  const handleChoiceKey = (record, event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      stepChoice(record, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!record.shell.classList.contains('is-open')) openChoiceRail(record);
      markActiveChoice(record, event.key === 'Home' ? 0 : record.optionNodes.length - 1);
      return;
    }
    if (event.key === 'Escape' && record.shell.classList.contains('is-open')) {
      event.preventDefault();
      closeChoiceRail(record, true);
      return;
    }
    if (event.key === 'Tab' && record.shell.classList.contains('is-open')) {
      closeChoiceRail(record);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!record.shell.classList.contains('is-open')) {
        openChoiceRail(record);
      } else if (record.activePosition >= 0) {
        const active = record.optionNodes[record.activePosition];
        commitChoice(record, Number(active.dataset.optionIndex));
      }
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      clearTimeout(record.typeaheadTimer);
      record.typeaheadBuffer = `${record.typeaheadBuffer || ''}${event.key}`.toLocaleLowerCase();
      record.typeaheadTimer = setTimeout(() => { record.typeaheadBuffer = ''; }, 650);
      if (!record.shell.classList.contains('is-open')) openChoiceRail(record);
      const matchPosition = record.optionNodes.findIndex((item) => (
        !item.classList.contains('is-disabled')
        && item.textContent.trim().toLocaleLowerCase().startsWith(record.typeaheadBuffer)
      ));
      if (matchPosition >= 0) markActiveChoice(record, matchPosition);
    }
  };

  const attachChoiceRail = (select) => {
    if (!(select instanceof HTMLSelectElement) || select.multiple || select.size > 1) return null;
    if (select.dataset.consoleChoice === 'native') return null;
    const existing = mountedChoices.get(select);
    if (existing) {
      refreshChoiceRail(existing);
      return existing;
    }

    const shell = document.createElement('div');
    const trigger = document.createElement('button');
    const value = document.createElement('span');
    const marker = document.createElement('span');
    const menu = document.createElement('div');
    const triggerId = nextIdentity('console-choice-trigger');
    const menuId = nextIdentity('console-choice-menu');

    shell.className = 'console-choice';
    shell.dataset.consoleChoiceFor = select.id || select.name || 'anonymous';
    trigger.type = 'button';
    trigger.id = triggerId;
    trigger.className = 'console-choice-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', menuId);
    value.className = 'console-choice-value';
    marker.className = 'console-choice-marker';
    marker.setAttribute('aria-hidden', 'true');
    menu.id = menuId;
    menu.className = 'console-choice-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

    select.parentNode.insertBefore(shell, select);
    select.classList.add('console-choice-source');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    shell.append(select, trigger, menu);
    trigger.append(value, marker);

    const record = {
      select,
      shell,
      trigger,
      value,
      marker,
      menu,
      optionNodes: [],
      activePosition: -1,
      typeaheadBuffer: '',
      typeaheadTimer: null,
    };
    mountedChoices.set(select, record);
    select.dataset.consoleChoiceMounted = 'true';

    trigger.addEventListener('click', () => {
      if (shell.classList.contains('is-open')) closeChoiceRail(record, true);
      else openChoiceRail(record);
    });
    trigger.addEventListener('keydown', (event) => handleChoiceKey(record, event));
    select.addEventListener('change', () => refreshChoiceRail(record));
    select.addEventListener('input', () => refreshChoiceRail(record));
    select.addEventListener('focus', () => trigger.focus());
    associatedLabel(select)?.addEventListener('click', (event) => {
      if (event.target.closest?.('.console-choice')) return;
      event.preventDefault();
      trigger.focus();
    });

    refreshChoiceRail(record);
    return record;
  };

  const conditionOptions = (dropdown) => [...dropdown.querySelectorAll('.condition-option')]
    .filter((option) => !option.hasAttribute('aria-disabled'));

  const syncConditionSemantics = (dropdown) => {
    const trigger = dropdown.querySelector('.condition-dropdown-trigger');
    const menu = dropdown.querySelector('.condition-dropdown-menu');
    if (!trigger || !menu) return;
    if (!dropdown.dataset.consoleMenuMounted) {
      const menuId = menu.id || nextIdentity('console-condition-menu');
      menu.id = menuId;
      dropdown.dataset.consoleMenuMounted = 'true';
      trigger.setAttribute('role', 'combobox');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-controls', menuId);
      menu.setAttribute('role', 'listbox');
      trigger.addEventListener('keydown', (event) => handleConditionKey(dropdown, event));
    }

    const options = conditionOptions(dropdown);
    options.forEach((option, index) => {
      if (!option.id) option.id = nextIdentity('console-condition-option');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', option.classList.contains('selected') ? 'true' : 'false');
      option.dataset.sequence = String(index + 1).padStart(2, '0');
    });

    const selectedIndex = options.findIndex((option) => option.classList.contains('selected'));
    const fallbackIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const storedIndex = Number(dropdown.dataset.activeConditionIndex);
    const activeIndex = Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < options.length
      ? storedIndex
      : fallbackIndex;
    const expanded = dropdown.classList.contains('open');
    trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (expanded) {
      openCondition = dropdown;
      activateConditionOption(dropdown, options.some((option) => option.classList.contains('is-active'))
        ? activeIndex
        : fallbackIndex);
      requestAnimationFrame(() => placeFloatingMenu(trigger, menu));
    } else {
      dropdown.dataset.activeConditionIndex = String(fallbackIndex);
      trigger.removeAttribute('aria-activedescendant');
      options.forEach((option) => {
        if (option.classList.contains('is-active')) option.classList.remove('is-active');
      });
      if (openCondition === dropdown) openCondition = null;
    }
  };

  const activateConditionOption = (dropdown, requestedPosition) => {
    const options = conditionOptions(dropdown);
    if (!options.length) return;
    const position = Math.max(0, Math.min(requestedPosition, options.length - 1));
    options.forEach((option, index) => {
      const shouldBeActive = index === position;
      if (option.classList.contains('is-active') !== shouldBeActive) {
        option.classList.toggle('is-active', shouldBeActive);
      }
    });
    const active = options[position];
    dropdown.dataset.activeConditionIndex = String(position);
    dropdown.querySelector('.condition-dropdown-trigger')?.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  };

  const closeConditionMenu = (dropdown, restoreFocus = false) => {
    if (!dropdown) return;
    dropdown.classList.remove('open');
    const trigger = dropdown.querySelector('.condition-dropdown-trigger');
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.removeAttribute('aria-activedescendant');
    dropdown.querySelectorAll('.condition-option').forEach((option) => {
      if (option.classList.contains('is-active')) option.classList.remove('is-active');
    });
    if (openCondition === dropdown) openCondition = null;
    if (restoreFocus) trigger?.focus();
  };

  const handleConditionKey = (dropdown, event) => {
    const options = conditionOptions(dropdown);
    const expanded = dropdown.classList.contains('open');
    const selected = options.findIndex((option) => option.classList.contains('selected'));
    const stored = Number(dropdown.dataset.activeConditionIndex);
    const current = Number.isInteger(stored) && stored >= 0 && stored < options.length
      ? stored
      : Math.max(0, selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) {
        if (openChoice) closeChoiceRail(openChoice);
        if (openCondition && openCondition !== dropdown) closeConditionMenu(openCondition);
        dropdown.classList.add('open');
      }
      activateConditionOption(dropdown, current + (event.key === 'ArrowDown' ? 1 : -1));
      syncConditionSemantics(dropdown);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (expanded) {
        options[current]?.click();
      } else {
        if (openChoice) closeChoiceRail(openChoice);
        if (openCondition && openCondition !== dropdown) closeConditionMenu(openCondition);
        dropdown.classList.add('open');
        syncConditionSemantics(dropdown);
      }
      return;
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      closeConditionMenu(dropdown, true);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!expanded) {
        if (openChoice) closeChoiceRail(openChoice);
        if (openCondition && openCondition !== dropdown) closeConditionMenu(openCondition);
        dropdown.classList.add('open');
      }
      activateConditionOption(dropdown, event.key === 'Home' ? 0 : options.length - 1);
      syncConditionSemantics(dropdown);
      return;
    }
    if (event.key === 'Tab' && expanded) closeConditionMenu(dropdown);
  };

  const mountTree = (root) => {
    if (!(root instanceof Element) && root !== document) return;
    if (root instanceof HTMLSelectElement) attachChoiceRail(root);
    root.querySelectorAll?.('select').forEach(attachChoiceRail);
    if (root instanceof HTMLElement && root.matches('.condition-dropdown')) syncConditionSemantics(root);
    root.querySelectorAll?.('.condition-dropdown').forEach(syncConditionSemantics);
  };

  const refreshMountedTree = (root) => {
    if (!(root instanceof Element)) return;
    if (root instanceof HTMLSelectElement) {
      const record = mountedChoices.get(root);
      if (record) refreshChoiceRail(record);
    }
    root.querySelectorAll?.('select').forEach((select) => {
      const record = mountedChoices.get(select);
      if (record) refreshChoiceRail(record);
    });
  };

  const observeConsole = () => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => mountTree(node));
          const ownerSelect = mutation.target instanceof Element ? mutation.target.closest('select') : null;
          if (ownerSelect) attachChoiceRail(ownerSelect);
          const labelRegion = mutation.target instanceof Element
            ? mutation.target.closest(
              'label, .form-label, .setting-row-label, .setting-label, .network-form-label, .history-v2-label, .capture-filter-label',
            )
            : null;
          const labeledSelect = labelRegion?.control
            || labelRegion?.closest(
              '.form-group, .setting-row, .setting-option, .setting-group, .network-form-group, .history-v2-field, .capture-filter-group',
            )?.querySelector('select');
          if (labeledSelect) attachChoiceRail(labeledSelect);
        }
        if (mutation.type === 'characterData') {
          const ownerSelect = mutation.target.parentElement?.closest('select');
          if (ownerSelect) attachChoiceRail(ownerSelect);
        }
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          if (mutation.target instanceof HTMLSelectElement) attachChoiceRail(mutation.target);
          const ownerSelect = mutation.target.closest('select');
          if (ownerSelect) attachChoiceRail(ownerSelect);
          if (mutation.target.matches('.condition-dropdown, .condition-option')) {
            const dropdown = mutation.target.closest('.condition-dropdown');
            if (dropdown) syncConditionSemantics(dropdown);
          }
          if (mutation.attributeName === 'style' || mutation.attributeName === 'hidden') {
            refreshMountedTree(mutation.target);
          }
        }
      });
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'disabled',
        'hidden',
        'style',
        'selected',
        'value',
        'label',
        'required',
        'aria-label',
        'aria-invalid',
      ],
    });
    return observer;
  };

  const repositionOpenMenus = () => {
    if (openChoice?.shell.classList.contains('is-open')) {
      placeFloatingMenu(openChoice.trigger, openChoice.menu);
    }
    if (openCondition?.classList.contains('open')) {
      const trigger = openCondition.querySelector('.condition-dropdown-trigger');
      const menu = openCondition.querySelector('.condition-dropdown-menu');
      if (trigger && menu) placeFloatingMenu(trigger, menu);
    }
  };

  const start = () => {
    if (!document.body || document.body.dataset.consoleChoicesReady === 'true') return;
    document.body.dataset.consoleChoicesReady = 'true';
    mountTree(document);
    observeConsole();
    document.addEventListener('click', (event) => {
      if (openChoice && !event.target.closest('.console-choice')) closeChoiceRail(openChoice);
      const condition = event.target.closest('.condition-dropdown');
      if (condition) requestAnimationFrame(() => syncConditionSemantics(condition));
    });
    document.addEventListener('scroll', repositionOpenMenus, true);
    window.addEventListener('resize', repositionOpenMenus);
  };

  globalScope.ConsoleChoiceRails = Object.freeze({
    start,
    mount: mountTree,
    refresh(select) {
      const record = mountedChoices.get(select);
      if (record) refreshChoiceRail(record);
      else attachChoiceRail(select);
    },
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(globalThis);
