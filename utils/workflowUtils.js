function isWorkingDay(date, workingDays, holidays) {
  if (workingDays.length > 0) {
    const dayOfWeek = date.getDay();
    const wDay = workingDays.find(w => w.day_of_week === dayOfWeek);
    if (wDay && !wDay.is_working) return false;
  }
  
  if (holidays.length > 0) {
    const dateStr = date.toISOString().split('T')[0];
    if (holidays.some(h => h.holiday_date.split('T')[0] === dateStr)) return false;
  }
  
  return true;
}

function getNextWorkingDay(date, workingDays, holidays) {
  let nextDate = new Date(date);
  while (!isWorkingDay(nextDate, workingDays, holidays)) {
    nextDate.setDate(nextDate.getDate() + 1);
  }
  return nextDate;
}

function addWorkingDays(startDate, days, workingDays, holidays) {
  let currentDate = new Date(startDate);
  let addedDays = 0;
  
  while (addedDays < days) {
    currentDate.setDate(currentDate.getDate() + 1);
    if (isWorkingDay(currentDate, workingDays, holidays)) {
      addedDays++;
    }
  }
  return currentDate;
}

function calculateTotalWorkingDays(start, end, workingDays, holidays) {
  let count = 0;
  let current = new Date(start);
  const endDate = new Date(end);
  
  while (current <= endDate) {
    if (isWorkingDay(current, workingDays, holidays)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  return count;
}

function distributeDates(startDateStr, endDateStr, stagesArray, workingDays = [], holidays = []) {
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  
  if (isNaN(start) || isNaN(end) || !stagesArray || stagesArray.length === 0) return [];

  const totalWorkingDays = calculateTotalWorkingDays(start, end, workingDays, holidays);
  
  let daysRemaining = totalWorkingDays;
  let equalStagesCount = 0;

  // First pass: allocate for 'manual' and 'percentage'
  const allocations = stagesArray.map(stage => {
    if (!stage.is_enabled) return { ...stage, days: 0 };
    
    let days = 0;
    if (stage.allocation_type === 'percentage') {
      days = Math.round((stage.allocation_value / 100) * totalWorkingDays);
      daysRemaining -= days;
    } else if (stage.allocation_type === 'manual') {
      days = Math.round(Number(stage.allocation_value) || 0);
      daysRemaining -= days;
    } else {
      equalStagesCount++;
    }
    return { ...stage, days };
  });

  // Second pass: allocate remaining for 'equal'
  if (equalStagesCount > 0) {
    // If daysRemaining is negative, it just means tight schedule, we floor it to 0 minimum
    const equalDays = Math.max(0, Math.floor(daysRemaining / equalStagesCount));
    let extraDays = Math.max(0, daysRemaining % equalStagesCount);
    
    allocations.forEach(a => {
      if (a.is_enabled && a.allocation_type === 'equal') {
        a.days = equalDays + (extraDays > 0 ? 1 : 0);
        if (extraDays > 0) extraDays--;
      }
    });
  }

  // FAILSAFE: If after all calculations, every stage got 0 days but we have a date span, distribute them forcefully
  const totalAllocated = allocations.reduce((sum, a) => sum + (a.days || 0), 0);
  if (totalAllocated === 0 && start < end) {
    const totalActualDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    let activeAllocations = allocations.filter(a => a.is_enabled);
    if (activeAllocations.length > 0 && totalActualDays > 0) {
      let equal = Math.floor(totalActualDays / activeAllocations.length);
      let rem = totalActualDays % activeAllocations.length;
      allocations.forEach(a => {
        if (a.is_enabled) {
          a.days = equal + (rem > 0 ? 1 : 0);
          if (rem > 0) rem--;
        }
      });
    }
  }

  // Generate date ranges
  let currentStart = getNextWorkingDay(start, workingDays, holidays);
  const dates = [];

  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    
    if (!alloc.is_enabled) {
      dates.push({ start: null, end: null, stage_id: alloc.id });
      continue;
    }

    let currentEnd;
    if (alloc.days === 0) {
      currentEnd = new Date(currentStart);
    } else {
      currentEnd = addWorkingDays(currentStart, Math.max(0, alloc.days - 1), workingDays, holidays);
    }

    // Cap dates to not exceed overall end date
    if (currentStart > end) currentStart = new Date(end);
    if (currentEnd > end) currentEnd = new Date(end);

    dates.push({
      start: currentStart.toISOString().split('T')[0],
      end: currentEnd.toISOString().split('T')[0],
      stage_id: alloc.id
    });

    if (alloc.days > 0) {
      const nextDay = new Date(currentEnd);
      nextDay.setDate(nextDay.getDate() + 1);
      currentStart = getNextWorkingDay(nextDay, workingDays, holidays);
    }
  }

  // Adjust last valid end date to not exceed the overall end date if possible
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i].end) {
      const stageEnd = new Date(dates[i].end);
      if (stageEnd > end) {
        dates[i].end = end.toISOString().split('T')[0];
      }
      break;
    }
  }

  return dates;
}

async function recalculateAllActivePOs(pool, company_id) {
  // Fetch active stages, working days, holidays
  const [allStages] = await pool.query(`
    SELECT ps.* FROM production_stages ps
    JOIN workflow_template_versions v ON ps.template_version_id = v.id
    JOIN workflow_templates t ON v.template_id = t.id
    WHERE t.company_id = ? AND v.is_active = TRUE
    ORDER BY ps.order_index ASC
  `, [company_id]);
  
  if (allStages.length === 0) return;

  const [workingDays] = await pool.query('SELECT * FROM working_days WHERE company_id = ?', [company_id]);
  const [holidays] = await pool.query('SELECT * FROM holiday_calendars WHERE company_id = ?', [company_id]);
  const safeStages = allStages.map(s => ({...s, is_enabled: s.is_enabled !== undefined ? s.is_enabled : 1}));

  // Fetch all active POs
  const [pos] = await pool.query('SELECT id, po_date, po_delivery_date FROM purchase_orders WHERE company_id = ? AND status != "completed"', [company_id]);

  for (const po of pos) {
    if (po.po_date && po.po_delivery_date) {
      const dates = distributeDates(po.po_date, po.po_delivery_date, safeStages, workingDays, holidays);
      
      // Delete old schedules
      await pool.query('DELETE FROM po_workflow_schedules WHERE po_id = ?', [po.id]);
      
      // Insert new schedules
      for (let i = 0; i < allStages.length; i++) {
        if (dates[i]) {
          await pool.query(
            'INSERT INTO po_workflow_schedules (po_id, stage_id, scheduled_start_date, scheduled_end_date, status) VALUES (?, ?, ?, ?, ?)',
            [po.id, allStages[i].id, dates[i].start || null, dates[i].end || null, 'pending']
          );
        }
      }
    }
  }
}

module.exports = { 
  distributeDates, 
  isWorkingDay, 
  addWorkingDays, 
  calculateTotalWorkingDays,
  getNextWorkingDay,
  recalculateAllActivePOs
};
