import {
    getOSPath,
    getFileContent,
    clearComments,
    getMD5Id,
    escapeRegExp,
    getTextRange,
    getSortPrefix
} from './util';

import {
    Definition,
    CompletionItem,
    Diagnostic,
    DiagnosticSeverity,
    Position,
    Location,
    Range,
    CompletionItemKind,
    InsertTextFormat,
    TextDocumentPositionParams
} from 'vscode-languageserver';

import * as glob from 'glob';

export type Step = {
    id: string,
    reg: RegExp,
    text: string,
    desc: string,
    def: Definition,
    count: number
};

export type StepsCountHash = {
    [step: string]: number
};

export default class StepsHandler {

    elements: Step[];

    elementsHash: { [step: string]: boolean } = {};

    elemenstCountHash: StepsCountHash = {};

    constructor(root: string, settings: Settings) {
        const { steps, syncfeatures } = settings.cucumberautocomplete;
        this.populate(root, steps);
        if (syncfeatures === true) {
            this.setElementsHash(`${root}/**/*.feature`);
        } else if (typeof syncfeatures === 'string') {
            this.setElementsHash(`${root}/${syncfeatures}`);
        }
    }

    getGherkinRegEx() {
        // I stripped out the languages from the original, as when the javascript test code was scanned in the original
        // only english was supported. This plugin only supports english language behave tests.
        const gherkinWords = escapeRegExp(`Given|When|Then|But|And`);
        return new RegExp(`^(\\s*)(${gherkinWords})(\\s+)(.*)`);
    }

    getElements(): Step[] {
        return this.elements;
    }

    setElementsHash(path: string): void {
        this.elemenstCountHash = {};
        const files = glob.sync(path, { ignore: '.gitignore' });
        files.forEach(f => {
            const text = getFileContent(f);
            text.split(/\r?\n/g).forEach(line => {
                const match = line.match(this.getGherkinRegEx());
                if (match) {
                    const step = this.getStepByText(match[4]);
                    if (step) {
                        this.incrementElementCount(step.id);
                    }
                }
            });
        });
        this.elements.forEach(el => el.count = this.getElementCount(el.id));
    }

    incrementElementCount(id: string): void {
        if (this.elemenstCountHash[id]) {
            this.elemenstCountHash[id]++;
        } else {
            this.elemenstCountHash[id] = 1;
        }
    }

    getElementCount(id: string): number {
        return this.elemenstCountHash[id] || 0;
    }

    getStepRegExp(): RegExp {

        //Actually, we dont care what the symbols are before our 'Gherkin' word
        //But they shouldn't end with letter
        const startPart = '^((?:[^\'"\/]*?[^\\w])|.{0})';

        //All the steps should be declared using any gherkin keyword. We should get first 'gherkin' word
        const gherkinPart = '(Given|When|Then|And|But)';

        //All the symbols, except of symbols, using as step start and letters, could be between gherkin word and our step
        const nonStepStartSymbols = `[^\/'"\\w]*?`;

        //Step text could be placed between '/' symbols (ex. in JS) or between quotes, like in Java
        const stepStart = `(\/|'|")`;

        //Our step could contain any symbols, except of our 'stepStart'. Use \3 to be sure in this
        const stepBody = '([^\\3]+)';

        //Step should be ended with same symbol it begins
        const stepEnd = '\\3';

        //Our RegExp will be case-insensitive to support cases like TypeScript (...@when...)
        const r = new RegExp(startPart + gherkinPart + nonStepStartSymbols + stepStart + stepBody + stepEnd, 'i');

        // /^((?:[^'"\/]*?[^\w])|.{0})(Given|When|Then|And|But)?[^\/'"\w]*?(\/|'|")([^\3]+)\3/i
        return r;

    }

    getMatch(line: string): RegExpMatchArray {
        return line.match(this.getStepRegExp());
    }

    getRegTextForStep(step: string): string {

        //Ruby interpolation (like `#{Something}` ) should be replaced with `.*`
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/65
        step = step.replace(/#{(.*?)}/g, '.*');

        //Built in transforms
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/66
        step = step.replace(/{float}/g, '-?\\d*\\.?\\d+');
        step = step.replace(/{int}/g, '-?\\d+');
        step = step.replace(/{stringInDoubleQuotes}/g, '"[^"]+"');

        //Handle Cucumber Expressions (like `{Something}`) should be replaced with `.*`
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/99
        //Cucumber Expressions Custom Parameter Type Documentation
        //https://docs.cucumber.io/cucumber-expressions/#custom-parameters
        step = step.replace(/([^\\]){(?![\d,])(.*?)}/g, '$1.*');

        //Escape all the regex symbols to avoid errors
        step = escapeRegExp(step);

        return step;
    }

    getTextForStep(step: string): string {

        //Remove all the backslashes
        step = step.replace(/\\/g, '');

        //Remove "string start" and "string end" RegEx symbols
        step = step.replace(/^\^|\$$/g, '');

        //All the "match" parts from double quotes should be removed
        //ex. `"(.*)"` should be changed by ""
        step = step.replace(/"\([^\)]*\)"/g, '""');

        return step;
    }

    getDescForStep(step: string): string {
        
        //Remove 'Function body' part
        step = step.replace(/\{.*/, '');

        //Remove spaces in the beginning end in the end of string
        step = step.replace(/^\s*/, '').replace(/\s*$/, '');

        //Remove body start characters "(/^" as well
        step = step.replace(/\(\/\^/, '');

        return step;
    }

    getStepTextInvariants(step: string): string[] {
        //Handle regexp's like 'I do (one|to|three)'
        if (~step.search(/(\([^\)^\()]+\|[^\(^\)]+\))/)) {
            const match = step.match(/(\([^\)]+\|[^\)]+\))/);
            const matchRes = match[1];
            const variants = matchRes.replace(/^\(|\)$/g, '').split('|');
            return variants.reduce((varRes, variant) => {
                return varRes.concat(this.getStepTextInvariants(step.replace(matchRes, variant)));
            }, []);
        } else {
            return [step];
        }
    }

    getCompletionInsertText(step: string): string {
        // PET-415
        // Process the step text, looking for our "insertable fields"
        // In the steps.js file generated by our Behave formatter we use {_ and _}
        var regex = /(?:\{_)(.+?)(?:_\})/g;
        var matches = [];
        var match;
        while (match = regex.exec (step))
        {
            // This gets the captured group, rather than the match itself. This means we
            // get the field name WITHOUT the "{_ _}" around it.
            matches.push(match[1]);
        }

        // 
        if (matches.length > 0) {
            for (let i = 0; i < matches.length; i++) {
                step = step.replace(/(?:\{_)(.+?)(?:_\})/, () => '${' + (i+1).toString() + ':<' + matches[i] + '>}');
            }
        }

        return step;
    }

    getSteps(fullStepLine: string, stepPart: string, def: Location): Step[] {
        const stepsVariants = this.getStepTextInvariants(stepPart);
        const desc = this.getDescForStep(fullStepLine);
        return stepsVariants.map((step) => {
            const reg = new RegExp(this.getRegTextForStep(step));
            //Todo we should store full value here
            const text = this.getTextForStep(step);
            const id = 'step' + getMD5Id(text);
            const count = this.getElementCount(id);
            return { id, reg, text, desc, def, count };
        });
    }

    getFileSteps(filePath: string): Step[] {
        const definitionFile = clearComments(getFileContent(filePath));
        return definitionFile.split(/\r?\n/g).reduce((steps, line, lineIndex) => {
            const match = this.getMatch(line);
            if (match) {
                const [, beforeGherkin, , , stepPart] = match;
                const pos = Position.create(lineIndex, beforeGherkin.length);
                const def = Location.create(getOSPath(filePath), Range.create(pos, pos));
                steps = steps.concat(this.getSteps(line, stepPart, def));
            }
            return steps;
        }, []);
    }

    validateConfiguration(settingsFile: string, stepsPathes: StepSettings, workSpaceRoot: string): Diagnostic[] {
        return stepsPathes.reduce((res, path) => {
            const files = glob.sync(path, { ignore: '.gitignore' });
            if (!files.length) {
                const searchTerm = path.replace(workSpaceRoot + '/', '');
                const range = getTextRange(workSpaceRoot + '/' + settingsFile, `"${searchTerm}"`);
                res.push({
                    severity: DiagnosticSeverity.Warning,
                    range: range,
                    message: `No steps files found`,
                    source: 'cucumberautocomplete'
                });
            }
            return res;
        }, []);
    }

    populate(root: string, stepsPathes: StepSettings): void {
        this.elementsHash = {};
        this.elements = stepsPathes
            .reduce((files, path) => files.concat(glob.sync(root + '/' + path, { ignore: '.gitignore' })), [])
            .reduce((elements, f) => elements.concat(
                this.getFileSteps(f).reduce((steps, step) => {
                    if (!this.elementsHash[step.id]) {
                        steps.push(step);
                        this.elementsHash[step.id] = true;
                    }
                    return steps;
                }, [])
            ), []);
    }

    getStepByText(text: string): Step {
        return this.elements.find(s => s.reg.test(text));
    }

    validate(line: string, lineNum: number): Diagnostic | null {
        line = line.replace(/\s*$/, '');
        const lineForError = line.replace(/^\s*/, '');
        const match = line.match(this.getGherkinRegEx());
        if (!match) {
            return null;
        }
        const beforeGherkin = match[1];
        const step = this.getStepByText(match[4]);
        if (step) {
            return null;
        } else {
            return {
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: lineNum, character: beforeGherkin.length },
                    end: { line: lineNum, character: line.length }
                },
                message: `Was unable to find step for "${lineForError}"`,
                source: 'cucumberautocomplete'
            };
        }
    }

    getDefinition(line: string, char: number): Definition | null {
        const match = line.match(this.getGherkinRegEx());
        if (!match) {
            return null;
        }
        const step = this.getStepByText(match[4]);
        return step ? step.def : null;
    }

    findLastStartingStepType(position: Position, text: string[]): string {
        // We have our current edit position in the file, and the entire file text
        // as an array (zero-indexed). Work backwards from the current line to find
        // the previous concrete gherkin step type.
        var retVal = "";
        for (var i=position.line-1; i >= 0; i--)
        {
            const match = text[i].match(this.getGherkinRegEx());
            // Reverse up and "And" steps there have been too
            if (match && (match[2] !== "And")) {
                // The gherkin keyword will have been grabbed into here...
                retVal = match[2];
                break;
            }
        }        

        return retVal;
    }

    getCompletion(line: string, position: Position, text: string[]): CompletionItem[] | null {
        // Get line part without gherkin part
        const match = line.match(this.getGherkinRegEx());
        // Do no work if they haven't typed a gherkin keyword yet
        let stepPart = ""
        let gherkinPart = ""
        if (!match) {
            // No match - they're typing free text, so allow the suggestions to pull free
            // text from the list of steps so the user can choose one.
            stepPart = line;
        }
        else // The user has already typed some form of concrete gherkin start
        {
            stepPart = match[4];
            gherkinPart = match[2]
        }

        // If we are typing an "And" step, we have a little work to do to establish what
        // kind of step we need to filter to. If it's one of the others, we can filter using
        // that step.
        if (gherkinPart == "And")
        {
            // We need to backtrack to the previous step which started with a concrete step type
            // this.
            gherkinPart = this.findLastStartingStepType(position, text);
        }        
        
        // Return all the braces into default state
        stepPart = stepPart.replace(/"[^"]*"/g, '""');
        // We should not obtain last word
        stepPart = stepPart.replace(/[^\s]+$/, '');
        // There is an unfinished feature here to try to suggest steps based on free text, as well
        // as when starting with a concrete step type. Right now if the user types a word which
        // appears in steps and requests suggestions, it won't work - I did get some way to making
        // this work but it needs more finesse (and understanding of this area). Right now this code
        // works if the user types a gherkin start keyword (concrete step type), then a keyword they
        // want to find. 
        const stepPartRe = new RegExp(stepPart);
        const res = this.elements
            .filter(step => {
                if (gherkinPart == "")
                    return step.text.search(stepPartRe) !== -1;
                else
                    return (step.text.search(stepPartRe) !== -1) && 
                            (step.desc.search(gherkinPart) !== -1)
            })
            .map(step => {
                const label = step.text.replace(stepPartRe, '');
                return {
                    label: label,
                    kind: CompletionItemKind.Snippet,
                    data: step.id,
                    sortText: getSortPrefix(step.count, 5) + '_' + label,
                    insertText: this.getCompletionInsertText(label),
                    insertTextFormat: InsertTextFormat.Snippet
                };
            });
        return res.length ? res : null;
    }

    getCompletionResolve(item: CompletionItem): CompletionItem {
        this.incrementElementCount(item.data);
        return item;
    };

}
