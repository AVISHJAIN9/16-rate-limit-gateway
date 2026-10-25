export class BoundedQueue {
    capacity;
    overflowPolicy;
    items = [];
    droppedCount = 0;
    constructor(capacity, overflowPolicy = 'drop_oldest') {
        this.capacity = capacity;
        this.overflowPolicy = overflowPolicy;
    }
    push(item) {
        if (this.items.length < this.capacity) {
            this.items.push(item);
            return true;
        }
        this.droppedCount++;
        switch (this.overflowPolicy) {
            case 'reject':
                return false;
            case 'drop_newest':
                return false;
            case 'drop_oldest':
                this.items.shift();
                this.items.push(item);
                return true;
        }
    }
    pop() {
        return this.items.shift();
    }
    get size() {
        return this.items.length;
    }
    clear() {
        this.items = [];
        this.droppedCount = 0;
    }
}
