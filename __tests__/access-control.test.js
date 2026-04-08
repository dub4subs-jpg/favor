const AccessControl = require('../core/access-control');

// --- Mock data ---

const TOOLS = [
  { function: { name: 'memory_save' } },
  { function: { name: 'server_exec' } },
  { function: { name: 'web_search' } },
];

const whatsappConfig = {
  platform: 'whatsapp',
  whatsapp: {
    operatorNumber: '+13055551234',
    dmPolicy: 'allowlist',
    allowFrom: ['+13055551234', '+13055559999'],
    trustedContacts: ['+13055558888'],
    staff: ['+13055557777'],
  },
};

const telegramConfig = {
  platform: 'telegram',
  telegram: {
    operatorChatId: '123456',
    dmPolicy: 'open',
    staff: ['789'],
    allowFrom: [],
  },
  whatsapp: { operatorNumber: '' },
};

let ac;

// --- Tests ---

describe('AccessControl', () => {
  // ── Constructor ──

  describe('constructor', () => {
    test('accepts config, PLATFORM, TOOLS and stores them', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.config).toBe(whatsappConfig);
      expect(ac.PLATFORM).toBe('whatsapp');
      expect(ac.TOOLS).toBe(TOOLS);
    });

    test('initializes empty LID maps', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.lidToPhone).toBeInstanceOf(Map);
      expect(ac.phoneToLid).toBeInstanceOf(Map);
      expect(ac.lidToPhone.size).toBe(0);
    });

    test('initializes empty verifiedNumbers and pendingAuth sets', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.verifiedNumbers).toBeInstanceOf(Set);
      expect(ac.pendingAuth).toBeInstanceOf(Set);
      expect(ac.verifiedNumbers.size).toBe(0);
      expect(ac.pendingAuth.size).toBe(0);
    });

    test('defines OPERATOR_ONLY_TOOLS, STAFF_TOOLS, CUSTOMER_TOOLS sets', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.OPERATOR_ONLY_TOOLS).toBeInstanceOf(Set);
      expect(ac.STAFF_TOOLS).toBeInstanceOf(Set);
      expect(ac.CUSTOMER_TOOLS).toBeInstanceOf(Set);
      expect(ac.OPERATOR_ONLY_TOOLS.has('server_exec')).toBe(true);
      expect(ac.STAFF_TOOLS.has('memory_save')).toBe(true);
      expect(ac.CUSTOMER_TOOLS.has('web_search')).toBe(true);
    });
  });

  // ── resolvePhone ──

  describe('resolvePhone', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('strips @s.whatsapp.net from JID', () => {
      expect(ac.resolvePhone('13055551234@s.whatsapp.net')).toBe('13055551234');
    });

    test('strips @c.us from JID', () => {
      expect(ac.resolvePhone('13055551234@c.us')).toBe('13055551234');
    });

    test('returns tg_ prefixed strings as-is', () => {
      expect(ac.resolvePhone('tg_123456')).toBe('tg_123456');
    });

    test('resolves LID JIDs via lidToPhone map', () => {
      ac.registerLidMapping('999:0@lid', '13055551234@s.whatsapp.net');
      expect(ac.resolvePhone('999:0@lid')).toBe('13055551234');
    });

    test('returns null for unknown LID JIDs', () => {
      expect(ac.resolvePhone('888:0@lid')).toBeNull();
    });

    test('handles LID JIDs with colon segments', () => {
      ac.registerLidMapping('555:42@lid', '13055559999@s.whatsapp.net');
      expect(ac.resolvePhone('555:42@lid')).toBe('13055559999');
    });

    test('returns plain number string for bare numbers', () => {
      expect(ac.resolvePhone('13055551234')).toBe('13055551234');
    });
  });

  // ── isOperator ──

  describe('isOperator', () => {
    describe('WhatsApp', () => {
      beforeEach(() => {
        ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      });

      test('returns true for matching operator JID', () => {
        expect(ac.isOperator('13055551234@s.whatsapp.net')).toBe(true);
      });

      test('returns true for matching operator @c.us JID', () => {
        expect(ac.isOperator('13055551234@c.us')).toBe(true);
      });

      test('returns false for non-operator number', () => {
        expect(ac.isOperator('13055559999@s.whatsapp.net')).toBe(false);
      });

      test('returns true for verified number', () => {
        ac.verifiedNumbers.add('13055550000');
        expect(ac.isOperator('13055550000@s.whatsapp.net')).toBe(true);
      });

      test('returns false for unresolvable LID', () => {
        expect(ac.isOperator('999:0@lid')).toBe(false);
      });

      test('returns true for LID mapped to operator number', () => {
        ac.registerLidMapping('999:0@lid', '13055551234@s.whatsapp.net');
        expect(ac.isOperator('999:0@lid')).toBe(true);
      });
    });

    describe('Telegram', () => {
      beforeEach(() => {
        ac = new AccessControl({ config: telegramConfig, PLATFORM: 'telegram', TOOLS });
      });

      test('returns true for matching operator chat ID', () => {
        expect(ac.isOperator('tg_123456')).toBe(true);
      });

      test('returns false for non-operator chat ID', () => {
        expect(ac.isOperator('tg_999999')).toBe(false);
      });

      test('returns true for verified Telegram JID', () => {
        ac.verifiedNumbers.add('tg_888888');
        expect(ac.isOperator('tg_888888')).toBe(true);
      });
    });

    describe('backwards compat (no operator set)', () => {
      test('WhatsApp: returns true when operatorNumber is empty', () => {
        const cfg = { whatsapp: { operatorNumber: '' } };
        ac = new AccessControl({ config: cfg, PLATFORM: 'whatsapp', TOOLS });
        expect(ac.isOperator('13059999999@s.whatsapp.net')).toBe(true);
      });

      test('Telegram: returns true when operatorChatId is empty', () => {
        const cfg = { telegram: {}, whatsapp: { operatorNumber: '' } };
        ac = new AccessControl({ config: cfg, PLATFORM: 'telegram', TOOLS });
        expect(ac.isOperator('tg_anyone')).toBe(true);
      });
    });
  });

  // ── isStaff ──

  describe('isStaff', () => {
    test('WhatsApp: returns true for staff phone number', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.isStaff('13055557777@s.whatsapp.net')).toBe(true);
    });

    test('WhatsApp: returns false for non-staff number', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.isStaff('13050001111@s.whatsapp.net')).toBe(false);
    });

    test('WhatsApp: returns false when staff list is empty', () => {
      const cfg = { whatsapp: { operatorNumber: '+13055551234', staff: [] } };
      ac = new AccessControl({ config: cfg, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.isStaff('13055557777@s.whatsapp.net')).toBe(false);
    });

    test('Telegram: returns true for staff chat ID', () => {
      ac = new AccessControl({ config: telegramConfig, PLATFORM: 'telegram', TOOLS });
      expect(ac.isStaff('tg_789')).toBe(true);
    });

    test('Telegram: returns false for non-staff chat ID', () => {
      ac = new AccessControl({ config: telegramConfig, PLATFORM: 'telegram', TOOLS });
      expect(ac.isStaff('tg_999')).toBe(false);
    });

    test('returns false for unresolvable LID', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.isStaff('777:0@lid')).toBe(false);
    });
  });

  // ── getRole ──

  describe('getRole', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('returns "operator" for operator number', () => {
      expect(ac.getRole('13055551234@s.whatsapp.net')).toBe('operator');
    });

    test('returns "staff" for staff number', () => {
      expect(ac.getRole('13055557777@s.whatsapp.net')).toBe('staff');
    });

    test('returns "customer" for unknown number', () => {
      expect(ac.getRole('10000000000@s.whatsapp.net')).toBe('customer');
    });
  });

  // ── canUseTool ──

  describe('canUseTool', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('operator can use any tool', () => {
      expect(ac.canUseTool('operator', 'server_exec')).toBe(true);
      expect(ac.canUseTool('operator', 'memory_save')).toBe(true);
      expect(ac.canUseTool('operator', 'web_search')).toBe(true);
      expect(ac.canUseTool('operator', 'nonexistent_tool')).toBe(true);
    });

    test('staff can use STAFF_TOOLS', () => {
      expect(ac.canUseTool('staff', 'memory_save')).toBe(true);
      expect(ac.canUseTool('staff', 'web_search')).toBe(true);
    });

    test('staff cannot use operator-only tools', () => {
      expect(ac.canUseTool('staff', 'server_exec')).toBe(false);
      expect(ac.canUseTool('staff', 'laptop_screenshot')).toBe(false);
    });

    test('customer can use CUSTOMER_TOOLS', () => {
      expect(ac.canUseTool('customer', 'web_search')).toBe(true);
      expect(ac.canUseTool('customer', 'knowledge_search')).toBe(true);
    });

    test('customer cannot use staff or operator tools', () => {
      expect(ac.canUseTool('customer', 'server_exec')).toBe(false);
      expect(ac.canUseTool('customer', 'memory_save')).toBe(false);
      expect(ac.canUseTool('customer', 'cron_create')).toBe(false);
    });
  });

  // ── canUseCommand ──

  describe('canUseCommand', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('operator can use any command', () => {
      expect(ac.canUseCommand('operator', '/update')).toBe(true);
      expect(ac.canUseCommand('operator', '/help')).toBe(true);
      expect(ac.canUseCommand('operator', '/model')).toBe(true);
      expect(ac.canUseCommand('operator', '/anything')).toBe(true);
    });

    test('staff can use staff commands', () => {
      expect(ac.canUseCommand('staff', '/status')).toBe(true);
      expect(ac.canUseCommand('staff', '/memory')).toBe(true);
      expect(ac.canUseCommand('staff', '/help')).toBe(true);
      expect(ac.canUseCommand('staff', '/laptop')).toBe(true);
    });

    test('staff cannot use admin commands', () => {
      expect(ac.canUseCommand('staff', '/update')).toBe(false);
      expect(ac.canUseCommand('staff', '/model')).toBe(false);
      expect(ac.canUseCommand('staff', '/reload')).toBe(false);
      expect(ac.canUseCommand('staff', '/clear')).toBe(false);
      expect(ac.canUseCommand('staff', '/sync')).toBe(false);
      expect(ac.canUseCommand('staff', '/recover')).toBe(false);
    });

    test('staff can use non-admin, non-staff commands (pass-through)', () => {
      // canUseCommand for staff: STAFF_COMMANDS.has(cmd) || !ADMIN_COMMANDS.has(cmd)
      // A random command that is neither admin nor staff should pass
      expect(ac.canUseCommand('staff', '/random')).toBe(true);
    });

    test('customer can only use /help and /status', () => {
      expect(ac.canUseCommand('customer', '/help')).toBe(true);
      expect(ac.canUseCommand('customer', '/status')).toBe(true);
    });

    test('customer cannot use other commands', () => {
      expect(ac.canUseCommand('customer', '/memory')).toBe(false);
      expect(ac.canUseCommand('customer', '/update')).toBe(false);
      expect(ac.canUseCommand('customer', '/laptop')).toBe(false);
      expect(ac.canUseCommand('customer', '/random')).toBe(false);
    });
  });

  // ── getToolsForRole ──

  describe('getToolsForRole', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('operator gets all TOOLS', () => {
      const tools = ac.getToolsForRole('operator');
      expect(tools).toBe(TOOLS);
      expect(tools.length).toBe(3);
    });

    test('staff gets only staff-permitted tools', () => {
      const tools = ac.getToolsForRole('staff');
      const names = tools.map(t => t.function.name);
      expect(names).toContain('memory_save');
      expect(names).toContain('web_search');
      expect(names).not.toContain('server_exec');
    });

    test('customer gets only customer-permitted tools', () => {
      const tools = ac.getToolsForRole('customer');
      const names = tools.map(t => t.function.name);
      expect(names).toContain('web_search');
      expect(names).not.toContain('memory_save');
      expect(names).not.toContain('server_exec');
    });

    test('returns empty array when no tools match role', () => {
      const noMatchTools = [{ function: { name: 'server_exec' } }];
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS: noMatchTools });
      const tools = ac.getToolsForRole('customer');
      expect(tools).toEqual([]);
    });
  });

  // ── isAllowed ──

  describe('isAllowed', () => {
    describe('WhatsApp allowlist mode', () => {
      beforeEach(() => {
        ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      });

      test('allows operator number', () => {
        expect(ac.isAllowed('13055551234@s.whatsapp.net')).toBe(true);
      });

      test('allows allowFrom number', () => {
        expect(ac.isAllowed('13055559999@s.whatsapp.net')).toBe(true);
      });

      test('allows trustedContacts number', () => {
        expect(ac.isAllowed('13055558888@s.whatsapp.net')).toBe(true);
      });

      test('allows staff number', () => {
        expect(ac.isAllowed('13055557777@s.whatsapp.net')).toBe(true);
      });

      test('blocks unknown number in allowlist mode', () => {
        expect(ac.isAllowed('10000000000@s.whatsapp.net')).toBe(false);
      });

      test('unknown LID JIDs pass through to auth gate', () => {
        const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
        expect(ac.isAllowed('999:0@lid')).toBe(true);
        spy.mockRestore();
      });
    });

    describe('WhatsApp open mode', () => {
      test('allows any number when dmPolicy is not allowlist', () => {
        const cfg = {
          whatsapp: {
            operatorNumber: '+13055551234',
            dmPolicy: 'open',
            allowFrom: [],
            staff: [],
          },
        };
        ac = new AccessControl({ config: cfg, PLATFORM: 'whatsapp', TOOLS });
        expect(ac.isAllowed('19999999999@s.whatsapp.net')).toBe(true);
      });
    });

    describe('WhatsApp allowlist with empty combined lists', () => {
      test('allows everyone when all lists are empty', () => {
        const cfg = {
          whatsapp: {
            operatorNumber: '+13055551234',
            dmPolicy: 'allowlist',
            allowFrom: [],
            trustedContacts: [],
            staff: [],
          },
        };
        ac = new AccessControl({ config: cfg, PLATFORM: 'whatsapp', TOOLS });
        expect(ac.isAllowed('19999999999@s.whatsapp.net')).toBe(true);
      });
    });

    describe('Telegram', () => {
      test('allows any JID when dmPolicy is open', () => {
        ac = new AccessControl({ config: telegramConfig, PLATFORM: 'telegram', TOOLS });
        expect(ac.isAllowed('tg_999999')).toBe(true);
      });

      test('allowlist mode with matching JID', () => {
        const cfg = {
          ...telegramConfig,
          telegram: {
            ...telegramConfig.telegram,
            dmPolicy: 'allowlist',
            allowFrom: ['123456', '789'],
          },
        };
        ac = new AccessControl({ config: cfg, PLATFORM: 'telegram', TOOLS });
        expect(ac.isAllowed('tg_123456')).toBe(true);
      });

      test('allowlist mode blocks non-matching JID', () => {
        const cfg = {
          ...telegramConfig,
          telegram: {
            ...telegramConfig.telegram,
            dmPolicy: 'allowlist',
            allowFrom: ['123456'],
          },
        };
        ac = new AccessControl({ config: cfg, PLATFORM: 'telegram', TOOLS });
        expect(ac.isAllowed('tg_999999')).toBe(false);
      });

      test('allowlist with empty allowFrom allows everyone', () => {
        const cfg = {
          ...telegramConfig,
          telegram: {
            ...telegramConfig.telegram,
            dmPolicy: 'allowlist',
            allowFrom: [],
          },
        };
        ac = new AccessControl({ config: cfg, PLATFORM: 'telegram', TOOLS });
        expect(ac.isAllowed('tg_anything')).toBe(true);
      });
    });
  });

  // ── isGroup ──

  describe('isGroup', () => {
    test('WhatsApp: @g.us is a group', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.isGroup('120363123456789@g.us')).toBe(true);
    });

    test('WhatsApp: @s.whatsapp.net is not a group', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.isGroup('13055551234@s.whatsapp.net')).toBe(false);
    });

    test('Telegram: negative ID is a group', () => {
      ac = new AccessControl({ config: telegramConfig, PLATFORM: 'telegram', TOOLS });
      expect(ac.isGroup('tg_-100123456')).toBe(true);
    });

    test('Telegram: positive ID is not a group', () => {
      ac = new AccessControl({ config: telegramConfig, PLATFORM: 'telegram', TOOLS });
      expect(ac.isGroup('tg_123456')).toBe(false);
    });

    test('Telegram: null/undefined returns false', () => {
      ac = new AccessControl({ config: telegramConfig, PLATFORM: 'telegram', TOOLS });
      expect(ac.isGroup(null)).toBe(false);
      expect(ac.isGroup(undefined)).toBe(false);
    });
  });

  // ── registerLidMapping ──

  describe('registerLidMapping', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('stores LID-to-phone and phone-to-LID mappings', () => {
      ac.registerLidMapping('555:0@lid', '13055551234@s.whatsapp.net');
      expect(ac.lidToPhone.get('555')).toBe('13055551234');
      expect(ac.phoneToLid.get('13055551234')).toBe('555');
    });

    test('strips @ suffix and colon segments from both JIDs', () => {
      ac.registerLidMapping('888:42@lid', '13059999999@s.whatsapp.net');
      expect(ac.lidToPhone.get('888')).toBe('13059999999');
    });

    test('does nothing when lidJid is falsy', () => {
      ac.registerLidMapping(null, '13055551234@s.whatsapp.net');
      expect(ac.lidToPhone.size).toBe(0);
    });

    test('does nothing when phoneJid is falsy', () => {
      ac.registerLidMapping('555:0@lid', null);
      expect(ac.lidToPhone.size).toBe(0);
    });

    test('overwrites previous mapping for same LID', () => {
      ac.registerLidMapping('555:0@lid', '13051111111@s.whatsapp.net');
      ac.registerLidMapping('555:0@lid', '13052222222@s.whatsapp.net');
      expect(ac.lidToPhone.get('555')).toBe('13052222222');
    });
  });

  // ── cleanup ──

  describe('cleanup', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('does nothing when maps are below 5000', () => {
      ac.registerLidMapping('1:0@lid', '1111@s.whatsapp.net');
      ac.registerLidMapping('2:0@lid', '2222@s.whatsapp.net');
      ac.cleanup();
      expect(ac.lidToPhone.size).toBe(2);
      expect(ac.phoneToLid.size).toBe(2);
    });

    test('trims maps when they exceed 5000 entries', () => {
      // Manually fill maps past 5000
      for (let i = 0; i < 5050; i++) {
        ac.lidToPhone.set(`lid${i}`, `phone${i}`);
        ac.phoneToLid.set(`phone${i}`, `lid${i}`);
      }
      expect(ac.lidToPhone.size).toBe(5050);
      ac.cleanup();
      expect(ac.lidToPhone.size).toBe(5000);
    });

    test('clears pendingAuth when it exceeds 100', () => {
      for (let i = 0; i < 101; i++) {
        ac.pendingAuth.add(`num${i}`);
      }
      expect(ac.pendingAuth.size).toBe(101);
      ac.cleanup();
      expect(ac.pendingAuth.size).toBe(0);
    });

    test('does not clear pendingAuth at 100 or below', () => {
      for (let i = 0; i < 100; i++) {
        ac.pendingAuth.add(`num${i}`);
      }
      ac.cleanup();
      expect(ac.pendingAuth.size).toBe(100);
    });
  });

  // ── updateConfig ──

  describe('updateConfig', () => {
    test('changes the config reference', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.config).toBe(whatsappConfig);

      const newConfig = { whatsapp: { operatorNumber: '+19991112222', dmPolicy: 'open', staff: [] } };
      ac.updateConfig(newConfig);
      expect(ac.config).toBe(newConfig);
      expect(ac.config.whatsapp.operatorNumber).toBe('+19991112222');
    });

    test('affects subsequent role checks', () => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
      expect(ac.isOperator('13055551234@s.whatsapp.net')).toBe(true);

      const newConfig = { whatsapp: { operatorNumber: '+19991112222', dmPolicy: 'open', staff: [] } };
      ac.updateConfig(newConfig);
      expect(ac.isOperator('13055551234@s.whatsapp.net')).toBe(false);
      expect(ac.isOperator('19991112222@s.whatsapp.net')).toBe(true);
    });
  });

  // ── verifiedNumbers / pendingAuth ──

  describe('verifiedNumbers and pendingAuth', () => {
    beforeEach(() => {
      ac = new AccessControl({ config: whatsappConfig, PLATFORM: 'whatsapp', TOOLS });
    });

    test('verifiedNumbers: add and check membership', () => {
      ac.verifiedNumbers.add('13055550000');
      expect(ac.verifiedNumbers.has('13055550000')).toBe(true);
      expect(ac.verifiedNumbers.has('13055550001')).toBe(false);
    });

    test('verifiedNumbers: remove via delete', () => {
      ac.verifiedNumbers.add('13055550000');
      ac.verifiedNumbers.delete('13055550000');
      expect(ac.verifiedNumbers.has('13055550000')).toBe(false);
    });

    test('verified number grants operator access', () => {
      expect(ac.isOperator('13055550000@s.whatsapp.net')).toBe(false);
      ac.verifiedNumbers.add('13055550000');
      expect(ac.isOperator('13055550000@s.whatsapp.net')).toBe(true);
    });

    test('pendingAuth: add and check membership', () => {
      ac.pendingAuth.add('13055550000');
      expect(ac.pendingAuth.has('13055550000')).toBe(true);
    });

    test('pendingAuth: clear empties the set', () => {
      ac.pendingAuth.add('a');
      ac.pendingAuth.add('b');
      ac.pendingAuth.clear();
      expect(ac.pendingAuth.size).toBe(0);
    });
  });
});
