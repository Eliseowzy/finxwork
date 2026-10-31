---
name: skill-creator
description: Writes a new skill, or improves an existing one, from what the user describes. Use when the user asks to create, write or turn something into a skill.
disable-model-invocation: true
---

# Creating a skill

A skill is a folder with a `SKILL.md` in it. finx lists every skill's name and description in the system prompt; the rest of the file is read only when a task matches. So the description decides when the skill is used, and the body decides how well.

## Where it goes

- For the user, in every project: `~/.finx/skills/<name>/SKILL.md`. Use this unless the user asks for something else.
- For one repository, shared with whoever uses it: `<project>/.agents/skills/<name>/SKILL.md`. Only when the user asks for that.

Do not write into other tools' folders such as `~/.claude/skills`.

## Steps

1. Find out what the skill is for: the task, and one or two requests it should handle. If the user's message already says, do not ask again.
2. Choose a name: lowercase letters, digits and single hyphens, at most 64 characters. The folder has the same name. If `~/.finx/skills/<name>` exists, ask before replacing it.
3. Write the header:

   ```markdown
   ---
   name: weekly-report
   description: Turns a week of notes into a report with done, problems and next week. Use when the user asks for a weekly report or summary of their week.
   ---
   ```

   The description is one or two sentences: what the skill does, then when to use it, in the words a user would say. Keep it under 1,024 characters.
4. Write the body as instructions to a capable colleague: the steps, the format of the result, the conventions to follow and the mistakes to avoid. Show a short example of the output when the format matters. Leave out what any model already knows.
5. Keep `SKILL.md` under about 500 lines. Put long material in `references/` and say in the body when to read which file. Put code that should run as-is in `scripts/`, and say how to run it.
6. Check the result: read the file back, make sure the header has `name` and `description`, and run `finx skills --all` to see it listed without problems.
7. Tell the user where the skill is, and that new conversations can use it: finx picks it when a task matches, or they type `/skill:<name>`.

## Improving a skill

Read the skill first. Change only what the user asked for, keep the name unless they want a new one, and check it the same way.
