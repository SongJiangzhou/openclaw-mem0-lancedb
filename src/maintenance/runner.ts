export type MaintenanceAction = 'sync' | 'migrate' | 'consolidate' | 'lifecycle' | 'all';

export type MaintenanceStepResult = {
  action: Exclude<MaintenanceAction, 'all'>;
  result: unknown;
};

export type MaintenanceTasks = {
  sync: () => Promise<unknown>;
  migrate: () => Promise<unknown>;
  consolidate: () => Promise<unknown>;
  lifecycle: () => Promise<unknown>;
};

export async function runMaintenance(params: {
  action: MaintenanceAction;
  tasks: MaintenanceTasks;
}): Promise<{ action: MaintenanceAction; steps: MaintenanceStepResult[] }> {
  const actions = params.action === 'all'
    ? ['sync', 'migrate', 'consolidate', 'lifecycle'] as const
    : [params.action];
  const steps: MaintenanceStepResult[] = [];

  for (const action of actions) {
    const result = await params.tasks[action]();
    steps.push({ action, result });
  }

  return {
    action: params.action,
    steps,
  };
}
