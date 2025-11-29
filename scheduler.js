/**
 * Планировщик задач и операций проекта
 *
 * Этот скрипт выполняет:
 * 1. Загрузку данных проекта и шаблона
 * 2. Расчет нормативов для задач/операций
 * 3. Планирование времени выполнения
 * 4. Назначение исполнителей с учетом параметров
 * 5. Отображение результатов в виде календаря
 */

(async function() {
    'use strict';

    // Глобальные переменные (предполагается, что они уже определены на странице)
    const db = window.db || 'orbits';
    const xsrf = window.xsrf || '';
    const host = window.location.hostname || 'integram.io';
    const baseUrl = `https://${host}/${db}`;

    // Флаг для включения детального логирования
    const DEBUG = true;

    // Вспомогательная функция для логирования
    function log(message, data = null) {
        if (DEBUG) {
            console.log(`[Scheduler] ${message}`, data || '');
        }
    }

    // Вспомогательная функция для логирования ошибок
    function error(message, err = null) {
        console.error(`[Scheduler ERROR] ${message}`, err || '');
    }

    /**
     * Выполняет GET-запрос к API
     */
    async function fetchData(reportId, params = 'JSON_KV') {
        const url = `${baseUrl}/report/${reportId}?${params}`;
        log(`Fetching data from: ${url}`);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            log(`Fetched ${data.length} records from report ${reportId}`);
            return data;
        } catch (err) {
            error(`Failed to fetch data from report ${reportId}`, err);
            throw err;
        }
    }

    /**
     * Выполняет POST-запрос для сохранения данных
     */
    async function saveData(itemId, params) {
        const url = `${baseUrl}/_m_set/${itemId}?JSON=1`;
        log(`Saving data to item ${itemId}`, params);

        const formData = new URLSearchParams();
        formData.append('_xsrf', xsrf);
        for (const [key, value] of Object.entries(params)) {
            formData.append(key, value);
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: formData.toString()
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            log(`Successfully saved data to item ${itemId}`);
            return result;
        } catch (err) {
            error(`Failed to save data to item ${itemId}`, err);
            throw err;
        }
    }

    /**
     * Парсит параметры задачи/операции в формате "ПараметрID:Значение(Значение MIN-Значение MAX)"
     */
    function parseParameters(paramStr) {
        if (!paramStr) return [];

        const params = [];
        const parts = paramStr.split(',');

        for (const part of parts) {
            const match = part.match(/(\d+):(.*?)(\((.*?)\))?$/);
            if (match) {
                const [, paramId, value, , range] = match;
                params.push({
                    parameterId: paramId,
                    value: value.trim(),
                    range: range ? range.trim() : null
                });
            }
        }

        return params;
    }

    /**
     * Проверяет, соответствует ли исполнитель параметрам задачи/операции
     */
    function matchesParameters(executor, parameters, parameterDictionary) {
        if (!parameters || parameters.length === 0) return true;

        for (const param of parameters) {
            const paramInfo = parameterDictionary.find(p => p['ПараметрID'] === param.parameterId);
            if (!paramInfo) continue;

            const paramName = paramInfo['Параметр'];

            // Проверка на обязательное заполнение (%)
            if (param.value === '%') {
                // Нужно проверить, что у исполнителя есть соответствующее свойство
                // Для упрощения считаем, что если значение требуется, оно должно быть непустым
                continue;
            }

            // Проверка роли (параметр 115)
            if (param.parameterId === '115' && executor['Роль']) {
                if (executor['Роль'] !== param.value) {
                    return false;
                }
            }

            // Проверка уровня квалификации (параметр 2673)
            if (param.parameterId === '2673' && executor['Квалификация -> Уровень']) {
                const requiredLevel = parseInt(param.value);
                const executorLevel = parseInt(executor['Квалификация -> Уровень']);

                if (param.range) {
                    // Если указан диапазон, проверяем вхождение
                    const rangeMatch = param.range.match(/(\d+)?-(\d+)?/);
                    if (rangeMatch) {
                        const [, minLevel, maxLevel] = rangeMatch;
                        if (minLevel && executorLevel < parseInt(minLevel)) return false;
                        if (maxLevel && executorLevel > parseInt(maxLevel)) return false;
                    }
                } else if (!isNaN(requiredLevel) && executorLevel !== requiredLevel) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Парсит занятое время исполнителя в формате "20251121:9-12,20251122:8-11"
     */
    function parseOccupiedTime(occupiedStr) {
        if (!occupiedStr) return [];

        const occupied = [];
        const parts = occupiedStr.split(',');

        for (const part of parts) {
            const match = part.match(/(\d{8}):(\d+)-(\d+)/);
            if (match) {
                const [, dateStr, startHour, endHour] = match;
                occupied.push({
                    date: dateStr,
                    startHour: parseInt(startHour),
                    endHour: parseInt(endHour)
                });
            }
        }

        return occupied;
    }

    /**
     * Форматирует дату в формат "YYYYMMDD"
     */
    function formatDateShort(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    /**
     * Форматирует дату и время в формат "DD.MM.YYYY HH:MM:SS"
     */
    function formatDateTime(date) {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
    }

    /**
     * Парсит дату из формата "DD.MM.YYYY"
     */
    function parseDate(dateStr) {
        if (!dateStr) return null;
        const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (!match) return null;
        const [, day, month, year] = match;
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }

    /**
     * Проверяет, свободен ли исполнитель в указанное время
     */
    function isExecutorAvailable(executor, date, startHour, endHour, currentAssignments) {
        const dateStr = formatDateShort(date);

        // Проверяем занятое время из базы данных
        const occupied = parseOccupiedTime(executor['Занятое время']);
        for (const slot of occupied) {
            if (slot.date === dateStr) {
                // Проверяем пересечение времени
                if (!(endHour <= slot.startHour || startHour >= slot.endHour)) {
                    return false;
                }
            }
        }

        // Проверяем текущие назначения
        const executorId = executor['ПользовательID'];
        const assignments = currentAssignments.filter(a => a.executorId === executorId);

        for (const assignment of assignments) {
            const assignmentDate = formatDateShort(assignment.startTime);
            if (assignmentDate === dateStr) {
                const assignmentStartHour = assignment.startTime.getHours();
                const assignmentEndHour = assignment.endTime.getHours();

                // Проверяем пересечение времени
                if (!(endHour <= assignmentStartHour || startHour >= assignmentEndHour)) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Рассчитывает время окончания задачи с учетом рабочих часов и обеда
     */
    function calculateEndTime(startTime, durationMinutes, settings) {
        const dayStart = settings.day_start || 9;
        const dayEnd = settings.day_end || 18;
        const lunchStart = settings.lunch_start || 13;
        const lunchDuration = 60; // 1 час обеда

        let currentTime = new Date(startTime);
        let remainingMinutes = durationMinutes;

        while (remainingMinutes > 0) {
            const currentHour = currentTime.getHours();
            const currentMinute = currentTime.getMinutes();

            // Проверяем, не выходим ли мы за пределы рабочего дня
            if (currentHour >= dayEnd) {
                // Переходим на следующий день
                currentTime.setDate(currentTime.getDate() + 1);
                currentTime.setHours(dayStart, 0, 0, 0);
                continue;
            }

            // Проверяем, не попадаем ли в обеденный перерыв
            if (currentHour === lunchStart && currentMinute === 0) {
                // Пропускаем обед
                currentTime.setHours(lunchStart + 1, 0, 0, 0);
                continue;
            }

            // Рассчитываем, сколько минут осталось до конца текущего периода
            let minutesUntilBreak;

            if (currentHour < lunchStart) {
                // До обеда
                minutesUntilBreak = (lunchStart - currentHour) * 60 - currentMinute;
            } else {
                // После обеда до конца дня
                minutesUntilBreak = (dayEnd - currentHour) * 60 - currentMinute;
            }

            if (remainingMinutes <= minutesUntilBreak) {
                // Задача завершится в текущем периоде
                currentTime.setMinutes(currentTime.getMinutes() + remainingMinutes);
                remainingMinutes = 0;
            } else {
                // Задача продолжится после перерыва
                remainingMinutes -= minutesUntilBreak;

                if (currentHour < lunchStart) {
                    // Переходим на время после обеда
                    currentTime.setHours(lunchStart + 1, 0, 0, 0);
                } else {
                    // Переходим на следующий день
                    currentTime.setDate(currentTime.getDate() + 1);
                    currentTime.setHours(dayStart, 0, 0, 0);
                }
            }
        }

        return currentTime;
    }

    /**
     * Генерирует HTML-таблицу с календарем назначений
     */
    function generateCalendar(assignments, executors, tasks) {
        log('Generating calendar HTML');

        // Группируем назначения по дням
        const assignmentsByDate = {};
        const executorMap = {};

        executors.forEach(ex => {
            executorMap[ex['ПользовательID']] = ex['Пользователь'];
        });

        for (const assignment of assignments) {
            const dateStr = assignment.startTime.toISOString().split('T')[0];
            if (!assignmentsByDate[dateStr]) {
                assignmentsByDate[dateStr] = [];
            }
            assignmentsByDate[dateStr].push(assignment);
        }

        // Сортируем даты
        const sortedDates = Object.keys(assignmentsByDate).sort();

        let html = '<table class="schedule-calendar" style="border-collapse: collapse; width: 100%; margin: 20px 0;">';
        html += '<thead><tr style="background-color: #f0f0f0;">';
        html += '<th style="border: 1px solid #ddd; padding: 8px;">Дата</th>';
        html += '<th style="border: 1px solid #ddd; padding: 8px;">Время</th>';
        html += '<th style="border: 1px solid #ddd; padding: 8px;">Задача/Операция</th>';
        html += '<th style="border: 1px solid #ddd; padding: 8px;">Исполнитель</th>';
        html += '<th style="border: 1px solid #ddd; padding: 8px;">Длительность (мин)</th>';
        html += '</tr></thead>';
        html += '<tbody>';

        for (const dateStr of sortedDates) {
            const dayAssignments = assignmentsByDate[dateStr];
            dayAssignments.sort((a, b) => a.startTime - b.startTime);

            for (const assignment of dayAssignments) {
                const task = tasks.find(t =>
                    (t['ОперацияID'] && t['ОперацияID'] === assignment.taskId) ||
                    (t['Задача проектаID'] && t['Задача проектаID'] === assignment.taskId)
                );

                const taskName = task ? (task['Операция'] || task['Задача проекта']) : 'Неизвестная задача';
                const executorName = executorMap[assignment.executorId] || 'Неизвестный';

                const startTimeStr = assignment.startTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                const endTimeStr = assignment.endTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

                html += '<tr>';
                html += `<td style="border: 1px solid #ddd; padding: 8px;">${new Date(dateStr).toLocaleDateString('ru-RU')}</td>`;
                html += `<td style="border: 1px solid #ddd; padding: 8px;">${startTimeStr} - ${endTimeStr}</td>`;
                html += `<td style="border: 1px solid #ddd; padding: 8px;">${taskName}</td>`;
                html += `<td style="border: 1px solid #ddd; padding: 8px;">${executorName}</td>`;
                html += `<td style="border: 1px solid #ddd; padding: 8px;">${assignment.duration}</td>`;
                html += '</tr>';
            }
        }

        html += '</tbody></table>';

        return html;
    }

    /**
     * Основная функция планирования
     */
    async function scheduleTasks() {
        try {
            log('Starting task scheduling...');

            // 1. Загружаем данные
            log('Step 1: Loading data...');
            const projectData = await fetchData(2681);
            const settings = await fetchData(3283);
            const parameterDictionary = await fetchData(3248);
            const executors = await fetchData(2777);

            // Преобразуем настройки в удобный формат
            const settingsMap = {};
            settings.forEach(s => {
                settingsMap[s['Код']] = parseInt(s['Значение']);
            });

            log('Loaded settings:', settingsMap);
            log(`Loaded ${executors.length} executors`);
            log(`Loaded ${parameterDictionary.length} parameters`);

            // 2. Разделяем данные на шаблон и рабочий проект
            log('Step 2: Separating template and working project...');
            const templateProject = projectData.filter(item => item['Статус проекта'] !== 'В работе');
            const workingProject = projectData.filter(item => item['Статус проекта'] === 'В работе');

            log(`Template project: ${templateProject.length} items`);
            log(`Working project: ${workingProject.length} items`);

            if (workingProject.length === 0) {
                throw new Error('No working project found with status "В работе"');
            }

            // 3. Рассчитываем нормативы для рабочего проекта
            log('Step 3: Calculating standards...');
            for (const item of workingProject) {
                const isOperation = !!item['ОперацияID'];
                const normativeField = isOperation ? 'Норматив операции' : 'Норматив задачи';
                const idField = isOperation ? 'ОперацияID' : 'Задача проектаID';
                const itemId = item[idField];

                // Если норматив уже заполнен, пропускаем
                if (item[normativeField]) {
                    log(`Item ${itemId} already has normative: ${item[normativeField]}`);
                    continue;
                }

                // Находим соответствующий элемент в шаблоне
                const templateItem = templateProject.find(t => {
                    if (isOperation) {
                        return t['Операция'] === item['Операция'] &&
                               t['Задача проекта'] === item['Задача проекта'];
                    } else {
                        return t['Задача проекта'] === item['Задача проекта'];
                    }
                });

                if (templateItem && templateItem[normativeField]) {
                    const templateNormative = parseFloat(templateItem[normativeField]);
                    const quantity = parseFloat(item['Кол-во'] || item['К-во'] || 1);
                    const calculatedNormative = templateNormative * quantity;

                    log(`Calculating normative for ${itemId}: ${templateNormative} × ${quantity} = ${calculatedNormative}`);

                    // Сохраняем рассчитанный норматив
                    const params = {};
                    params[isOperation ? 't3094' : 't3094'] = calculatedNormative.toString();

                    // В режиме отладки не сохраняем, только логируем
                    if (!DEBUG) {
                        await saveData(itemId, params);
                    } else {
                        log(`Would save normative ${calculatedNormative} to item ${itemId}`);
                    }

                    // Обновляем локальное значение
                    item[normativeField] = calculatedNormative.toString();
                }
            }

            // 4. Планируем время начала задач и операций
            log('Step 4: Scheduling task start times...');

            // Получаем дату старта проекта
            const projectStartDate = parseDate(workingProject[0]['Старт']);
            if (!projectStartDate) {
                throw new Error('Project start date not found');
            }

            log(`Project start date: ${projectStartDate.toLocaleDateString('ru-RU')}`);

            // Группируем задачи по последовательности
            const taskGroups = [];
            const processedTasks = new Set();

            for (const item of workingProject) {
                const taskId = item['Задача проектаID'];
                if (processedTasks.has(taskId)) continue;

                const taskOperations = workingProject.filter(i =>
                    i['Задача проектаID'] === taskId && i['ОперацияID']
                );

                if (taskOperations.length > 0) {
                    // Задача с операциями
                    taskGroups.push({
                        taskId,
                        taskName: item['Задача проекта'],
                        items: taskOperations,
                        previousTask: item['Предыдущая Задача']
                    });
                } else {
                    // Задача без операций
                    taskGroups.push({
                        taskId,
                        taskName: item['Задача проекта'],
                        items: [item],
                        previousTask: item['Предыдущая Задача']
                    });
                }

                processedTasks.add(taskId);
            }

            log(`Created ${taskGroups.length} task groups`);

            // Упорядочиваем задачи по последовательности
            const orderedTasks = [];
            const taskMap = new Map(taskGroups.map(tg => [tg.taskName, tg]));

            // Находим первую задачу (без предыдущей)
            let currentTask = taskGroups.find(tg => !tg.previousTask);

            while (currentTask) {
                orderedTasks.push(currentTask);
                const nextTask = taskGroups.find(tg => tg.previousTask === currentTask.taskName);
                currentTask = nextTask;
            }

            log(`Ordered ${orderedTasks.length} tasks`);

            // 5. Назначаем исполнителей и планируем время
            log('Step 5: Assigning executors and scheduling...');

            let currentTime = new Date(projectStartDate);
            currentTime.setHours(settingsMap.day_start || 9, 0, 0, 0);

            const assignments = [];

            for (const taskGroup of orderedTasks) {
                log(`Processing task group: ${taskGroup.taskName}`);

                for (const item of taskGroup.items) {
                    const isOperation = !!item['ОперацияID'];
                    const itemId = isOperation ? item['ОперацияID'] : item['Задача проектаID'];
                    const itemName = isOperation ? item['Операция'] : item['Задача проекта'];
                    const normativeField = isOperation ? 'Норматив операции' : 'Норматив задачи';
                    const normative = parseFloat(item[normativeField] || 0);

                    if (normative === 0) {
                        log(`Skipping item ${itemId} (${itemName}) - no normative`);
                        continue;
                    }

                    log(`Scheduling item ${itemId} (${itemName}), duration: ${normative} minutes`);

                    // Парсим параметры
                    const parameters = parseParameters(item['Параметры задачи']);

                    // Находим подходящих исполнителей
                    const suitableExecutors = executors.filter(ex =>
                        matchesParameters(ex, parameters, parameterDictionary)
                    );

                    log(`Found ${suitableExecutors.length} suitable executors for item ${itemId}`);

                    // Определяем требуемое количество исполнителей
                    const requiredExecutors = parseInt(item['Исполнителей'] || 1);

                    // Находим свободных исполнителей
                    const availableExecutors = [];
                    for (const executor of suitableExecutors) {
                        if (isExecutorAvailable(
                            executor,
                            currentTime,
                            currentTime.getHours(),
                            currentTime.getHours() + Math.ceil(normative / 60),
                            assignments
                        )) {
                            availableExecutors.push(executor);
                            if (availableExecutors.length >= requiredExecutors) break;
                        }
                    }

                    if (availableExecutors.length < requiredExecutors) {
                        log(`Warning: Not enough available executors for item ${itemId}. Required: ${requiredExecutors}, Available: ${availableExecutors.length}`);
                    }

                    // Назначаем исполнителей
                    const startTime = new Date(currentTime);
                    const endTime = calculateEndTime(startTime, normative, settingsMap);

                    for (const executor of availableExecutors) {
                        assignments.push({
                            taskId: itemId,
                            taskName: itemName,
                            executorId: executor['ПользовательID'],
                            executorName: executor['Пользователь'],
                            startTime: new Date(startTime),
                            endTime: new Date(endTime),
                            duration: normative
                        });
                    }

                    // Сохраняем время начала
                    const startTimeParam = isOperation ? 't2665' : 't798';
                    const params = {};
                    params[startTimeParam] = formatDateTime(startTime);

                    if (!DEBUG) {
                        await saveData(itemId, params);
                    } else {
                        log(`Would save start time ${formatDateTime(startTime)} to item ${itemId}`);
                    }

                    // Обновляем текущее время
                    currentTime = new Date(endTime);

                    // Если задача длительностью <= 4 часов и завершается после конца дня,
                    // переносим её на следующий день
                    if (normative <= 240 && endTime.getHours() >= (settingsMap.day_end || 18)) {
                        currentTime.setDate(currentTime.getDate() + 1);
                        currentTime.setHours(settingsMap.day_start || 9, 0, 0, 0);
                    }
                }
            }

            log(`Created ${assignments.length} assignments`);

            // 6. Генерируем HTML-календарь
            log('Step 6: Generating calendar...');
            const calendarHtml = generateCalendar(assignments, executors, workingProject);

            // 7. Выводим результат
            const contentDiv = document.querySelector('.content');
            if (contentDiv) {
                contentDiv.innerHTML = '<h2>График выполнения задач</h2>' + calendarHtml;
                log('Calendar displayed successfully');
            } else {
                error('Content div not found!');
            }

            log('Task scheduling completed successfully!');

        } catch (err) {
            error('Failed to schedule tasks', err);
            const contentDiv = document.querySelector('.content');
            if (contentDiv) {
                contentDiv.innerHTML = `<div style="color: red; padding: 20px;">
                    <h3>Ошибка планирования</h3>
                    <p>${err.message}</p>
                    <p>Подробности в консоли браузера (F12)</p>
                </div>`;
            }
        }
    }

    // Запускаем планирование
    await scheduleTasks();

})();
