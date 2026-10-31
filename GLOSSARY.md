# Nightjar

Nightjar builds a Feature's Tickets on one branch with nobody at the keyboard, for any stack, tracker or code host.

## Language

**Workflow**:
A named list of Steps that a repo adds to Nightjar's fixed build loop, chosen per Feature.
_Avoid_: Flow, pipeline, process

**Step**:
One instruction in a Workflow, given to the agent at a fixed point in a build: after each Ticket, or after all Tickets.
_Avoid_: Stage, phase, hook, task
